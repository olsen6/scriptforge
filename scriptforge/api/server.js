import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import rateLimit from 'express-rate-limit'
import OpenAI from 'openai'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

dotenv.config()

const app = express()
app.set('trust proxy', 1)

const PORT = process.env.PORT || 3001
const FREE_USER_LIMIT = 10
const LOGGED_OUT_LIMIT = 3
const STORY_MAX_CHARS = 12_000
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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

const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 250,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many API requests. Try again in one hour.' },
})

const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit reached. Try again in one hour.' },
})

const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout requests. Try again later.' },
})

const webhookLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many webhook requests. Try again later.' },
})

app.use(cors())
app.use('/api', apiLimiter)
app.post(
  '/api/stripe-webhook',
  webhookLimiter,
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe || !supabaseAdmin) {
      return res.status(500).json({
        error:
          'Stripe or Supabase service role key missing. Check environment variables.',
      })
    }

    const signature = req.headers['stripe-signature']
    if (
      typeof signature !== 'string' ||
      !signature ||
      !process.env.STRIPE_WEBHOOK_SECRET
    ) {
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
          const userId = sanitizeUuid(session?.metadata?.userId)

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

  const payload = asPlainObject(req.body)
  const story = sanitizeStory(payload.story)
  const userId = sanitizeNullableUuid(payload.userId)
  const isPaid = sanitizeBoolean(payload.isPaid)

  if (!story) return res.status(400).json({ error: 'Story is required.' })
  if (story.length > STORY_MAX_CHARS) {
    return res
      .status(400)
      .json({ error: `Story exceeds maximum length of ${STORY_MAX_CHARS} characters.` })
  }
  if (payload.userId !== undefined && payload.userId !== null && !userId) {
    return res.status(400).json({ error: 'Invalid userId format.' })
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

  const payload = asPlainObject(req.body)
  const userId = sanitizeUuid(payload.userId)
  const userEmail = sanitizeEmail(payload.userEmail)

  if (!userId || !userEmail) {
    return res.status(400).json({ error: 'userId and userEmail are required.' })
  }

  try {
    const baseUrl = sanitizeBaseUrl(
      process.env.APP_URL || req.headers.origin || 'http://localhost:5173',
    )
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

function asPlainObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  return input
}

function sanitizeString(value, maxLength = 1000) {
  if (typeof value !== 'string') return ''
  const cleaned = value
    .replace(/\0/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
  if (!maxLength) return cleaned
  return cleaned.slice(0, maxLength)
}

function sanitizeStory(value) {
  const cleaned = sanitizeString(value, STORY_MAX_CHARS + 1).replace(/\r\n/g, '\n')
  return cleaned
}

function sanitizeUuid(value) {
  const cleaned = sanitizeString(value, 80).toLowerCase()
  if (!UUID_PATTERN.test(cleaned)) return null
  return cleaned
}

function sanitizeNullableUuid(value) {
  if (value === undefined || value === null || value === '') return null
  return sanitizeUuid(value)
}

function sanitizeEmail(value) {
  const cleaned = sanitizeString(value, 320).toLowerCase()
  if (!EMAIL_PATTERN.test(cleaned)) return null
  return cleaned
}

function sanitizeBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function sanitizeBaseUrl(value) {
  try {
    const parsed = new URL(String(value))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Invalid protocol.')
    }
    return `${parsed.protocol}//${parsed.host}`
  } catch (_error) {
    return 'http://localhost:5173'
  }
}
