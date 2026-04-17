import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import rateLimit from 'express-rate-limit'
import OpenAI from 'openai'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

// Load from visible "env" file first, then fallback to ".env".
dotenv.config({ path: 'env' })
dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001
const FREE_USER_LIMIT = 10
const LOGGED_OUT_LIMIT = 3

const SYSTEM_PROMPT =
  "You are a viral TikTok script writer. You think like a human who posts daily and gets millions of views. Before you write ask yourself: does this story make me feel ANGER, FEAR, or INJUSTICE? If no, amplify the stakes. HOOK: first 5 words must grab the throat, start with a body count, dollar amount, or betrayal, never start with 'What happened when' or 'You won't believe.' ESCALATION: each bullet adds a new layer of pain, include specifics like dates and dollar amounts, add [PAUSE] before the worst reveal. TWIST: someone knew and didn't tell, the victim was blamed, must be rewatchable. ENGAGEMENT BAIT: polarizing question with two sides, end with 'Comment TEAM A or TEAM B.' Forbidden words: delicious, interesting, perhaps, slightly. Required words: caught, confessed, discovered, admitted, realized, collapsed, froze. Format exactly: 🔥 HOOK: [hook]. 📈 ESCALATION: [bullets]. 🎭 TWIST: [twist]. 💬 ENGAGEMENT BAIT: [question]."

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null

const supabaseAdmin =
  process.env.VITE_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.VITE_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        {
          auth: {
            autoRefreshToken: false,
            persistSession: false,
          },
        },
      )
    : null

const guestGenerationTracker = new Map()

const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit reached. Try again in one hour.' },
})

app.use(cors())
app.post(
  '/api/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe || !supabaseAdmin) {
      return res.status(500).json({
        error:
          'Stripe or Supabase service role key missing. Check environment variables.',
      })
    }

    const signature = req.headers['stripe-signature']
    if (!signature || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(400).json({ error: 'Invalid webhook signature settings.' })
    }

    let event
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET,
      )
    } catch (error) {
      return res.status(400).json({ error: `Webhook Error: ${error.message}` })
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object
          const userId = session?.metadata?.userId

          if (userId) {
            const { error } = await supabaseAdmin
              .from('user_subscriptions')
              .upsert(
                {
                  user_id: userId,
                  status: 'active',
                  stripe_customer_id: session.customer
                    ? String(session.customer)
                    : null,
                  plan_type: 'monthly',
                  updated_at: new Date().toISOString(),
                },
                { onConflict: 'user_id' },
              )

            if (error) throw error
          }
          break
        }
        case 'customer.subscription.deleted': {
          const subscription = event.data.object
          const customerId = subscription.customer
            ? String(subscription.customer)
            : null

          if (customerId) {
            const { data: existingRow, error: selectError } = await supabaseAdmin
              .from('user_subscriptions')
              .select('user_id')
              .eq('stripe_customer_id', customerId)
              .maybeSingle()

            if (selectError) throw selectError

            if (existingRow?.user_id) {
              const { error: updateError } = await supabaseAdmin
                .from('user_subscriptions')
                .update({
                  status: 'inactive',
                  updated_at: new Date().toISOString(),
                })
                .eq('user_id', existingRow.user_id)

              if (updateError) throw updateError
            }
          }
          break
        }
        default:
          break
      }
    } catch (error) {
      console.error('Stripe webhook processing failed:', error)
      return res.status(500).json({ error: 'Failed to process webhook event.' })
    }

    return res.json({ received: true })
  },
)

app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.post('/api/generate', generateLimiter, async (req, res) => {
  if (!openai || !supabaseAdmin) {
    return res.status(500).json({
      error:
        'Server missing OPENAI_API_KEY, VITE_SUPABASE_URL, or SUPABASE_SERVICE_ROLE_KEY.',
    })
  }

  const { story, userId, isPaid } = req.body ?? {}

  if (!story || typeof story !== 'string') {
    return res.status(400).json({ error: 'Story is required.' })
  }

  let activePaidAccess = Boolean(isPaid)
  let userCount = 0

  try {
    if (!userId) {
      const guestUsage = getGuestUsage(req.ip)
      if (guestUsage.count >= LOGGED_OUT_LIMIT) {
        return res.status(402).json({
          code: 'LIMIT_REACHED',
          error:
            'Free guest limit reached (3 generations). Sign in or upgrade to continue.',
        })
      }
    } else {
      activePaidAccess = activePaidAccess || (await hasPaidAccess(userId))

      if (!activePaidAccess) {
        const userUsage = await getUserUsage(userId)
        userCount = userUsage.count

        if (userCount >= FREE_USER_LIMIT) {
          return res.status(402).json({
            code: 'LIMIT_REACHED',
            error: 'Monthly free limit reached (10 generations).',
            count: userCount,
            limit: FREE_USER_LIMIT,
          })
        }
      }
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.9,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: story },
      ],
    })

    const script = completion.choices?.[0]?.message?.content?.trim()
    if (!script) {
      throw new Error('OpenAI returned an empty script.')
    }

    if (!userId) {
      const guestUsage = getGuestUsage(req.ip)
      guestUsage.count += 1
      return res.json({
        script,
        isPaid: false,
        remainingGuestGenerations: Math.max(0, LOGGED_OUT_LIMIT - guestUsage.count),
      })
    }

    if (!activePaidAccess) {
      const updatedCount = await incrementUserUsage(userId, userCount + 1)
      return res.json({
        script,
        count: updatedCount,
        limit: FREE_USER_LIMIT,
        isPaid: false,
      })
    }

    return res.json({
      script,
      count: userCount,
      limit: FREE_USER_LIMIT,
      isPaid: true,
    })
  } catch (error) {
    console.error('/api/generate failed:', error)
    return res.status(500).json({ error: 'Failed to generate script.' })
  }
})

app.post('/api/create-checkout', async (req, res) => {
  if (!stripe) {
    return res
      .status(500)
      .json({ error: 'Missing STRIPE_SECRET_KEY in environment.' })
  }

  const { userId, userEmail } = req.body ?? {}
  if (!userId || !userEmail) {
    return res.status(400).json({ error: 'userId and userEmail are required.' })
  }

  try {
    const baseUrl = process.env.APP_URL || req.headers.origin || 'http://localhost:5173'
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: userEmail,
      success_url: `${baseUrl}/?checkout=success`,
      cancel_url: `${baseUrl}/?checkout=cancelled`,
      metadata: { userId },
      subscription_data: { metadata: { userId } },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: 1200,
            recurring: { interval: 'month' },
            product_data: {
              name: 'ScriptForge Pro',
              description: 'Unlimited Reddit-to-TikTok script generations',
            },
          },
        },
      ],
    })

    return res.json({ url: session.url })
  } catch (error) {
    console.error('/api/create-checkout failed:', error)
    return res.status(500).json({ error: 'Unable to create checkout session.' })
  }
})

app.listen(PORT, () => {
  console.log(`ScriptForge API listening on port ${PORT}`)
})

function monthKey(date) {
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}`
}

function getGuestUsage(ipAddress) {
  const key = ipAddress || 'unknown-ip'
  const nowKey = monthKey(new Date())
  const existing = guestGenerationTracker.get(key)

  if (!existing || existing.monthKey !== nowKey) {
    const freshUsage = { count: 0, monthKey: nowKey }
    guestGenerationTracker.set(key, freshUsage)
    return freshUsage
  }

  return existing
}

async function hasPaidAccess(userId) {
  const { data, error } = await supabaseAdmin
    .from('user_subscriptions')
    .select('status')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return data?.status === 'active'
}

async function getUserUsage(userId) {
  const { data, error } = await supabaseAdmin
    .from('user_counts')
    .select('count, last_reset')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  const now = new Date()
  const nowKey = monthKey(now)

  if (!data) {
    const { error: insertError } = await supabaseAdmin
      .from('user_counts')
      .insert({
        user_id: userId,
        count: 0,
        last_reset: now.toISOString(),
      })

    if (insertError) throw insertError
    return { count: 0 }
  }

  const rowKey = data.last_reset ? monthKey(new Date(data.last_reset)) : nowKey
  if (rowKey !== nowKey) {
    const { error: resetError } = await supabaseAdmin
      .from('user_counts')
      .update({
        count: 0,
        last_reset: now.toISOString(),
      })
      .eq('user_id', userId)

    if (resetError) throw resetError
    return { count: 0 }
  }

  return { count: data.count ?? 0 }
}

async function incrementUserUsage(userId, nextCount) {
  const { data, error } = await supabaseAdmin
    .from('user_counts')
    .update({
      count: nextCount,
      last_reset: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .select('count')
    .single()

  if (error) throw error
  return data.count
}
