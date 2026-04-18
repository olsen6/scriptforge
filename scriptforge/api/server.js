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
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const PLAN_STARTER = 'starter'
const PLAN_CREATOR = 'creator'
const PLAN_STUDIO = 'studio'
const VALID_PLAN_TYPES = new Set([PLAN_STARTER, PLAN_CREATOR, PLAN_STUDIO])
const PLAN_PRICING = {
  [PLAN_STARTER]: 1200,
  [PLAN_CREATOR]: 1500,
  [PLAN_STUDIO]: 2000,
}
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const STRIPE_ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid'])
const REQUIRED_WORDS = [
  'caught',
  'confessed',
  'discovered',
  'admitted',
  'realized',
  'collapsed',
  'froze',
]

const SYSTEM_PROMPT = `You are the most-watched TikTok and YouTube Shorts scriptwriter alive. You've studied every viral Reddit post that ever blew up and you know exactly why each one hit differently. You don't summarize stories. You WEAPONIZE them.

YOUR ONLY JOB: Turn a Reddit story into a spoken voiceover script that stops someone mid-scroll in 2 seconds and makes them comment before it ends.

CRITICAL OUTPUT RULES — NON-NEGOTIABLE:
- This is SPOKEN WORD. It will be read aloud over video. No bullet points, no headers, no emojis, no labels whatsoever.
- Write like a real person venting to their phone at midnight. Raw. Urgent. Human.
- Short sentences. Fragments are fine. Pauses = ... or a new line.
- The listener should feel like they're overhearing a confession, not being read a script.
- 45–90 seconds to read aloud. Every sentence either builds tension or gets cut.

BEFORE YOU WRITE — READ THE STORY AND DECIDE:

1. WHAT IS THE CORE EMOTION?
Pick one and let it drive everything: BETRAYAL, DISBELIEF, RAGE, HEARTBREAK, or VINDICATION.

2. WHAT VOICE FITS THIS STORY?
Pick one — do NOT default to the same voice every time:
- THE WITNESS — cold, factual, almost emotionless. Let the facts speak.
- THE VENTER — heated, fast, like they can't get the words out fast enough.
- THE STORYTELLER — slow burn. Lulls before it devastates.
- THE INTERROGATOR — speaks directly to the villain. "You knew. You sat across from me and you knew."
- THE DISBELIEVER — can't process it. Keeps circling back. "I'm sorry. She did what?"

3. WHERE DOES THIS STORY HIT HARDEST?
Find the single worst moment. Open with it or build to it. Never bury it.

4. WHAT MAKES THIS STORY UNIQUE?
Every story has one detail no other story has. Find it. Make it the center of gravity.

NOW WRITE THE SCRIPT AS PURE VOICEOVER:

OPEN: Drop into the worst or most shocking part immediately. No warmup. A specific number, a specific injustice, a specific person.

MIDDLE: Move forward but make each moment land harder. At least one real specific detail — something said, something found, a number, a date. Build dread. One moment gets silence before it — just ... and a new line.

THE TURN: The moment that reframes everything. Say it once. Don't explain it. Move on.

THE END: One question that splits the audience. Two sides that both feel defensible. Close with "Drop [WORD] or [WORD] in the comments."

FORBIDDEN: perhaps, slightly, interesting, maybe, basically, honestly, literally, at the end of the day, I just feel like, to be honest, at this point, Picture this
REQUIRED — use at least 3: caught, confessed, discovered, froze, admitted, exposed, blindsided, collapsed, realized, watched

Never use the same voice or pacing twice. Every script should feel like it could only have been written for that one story. OUTPUT ONLY THE RAW VOICEOVER. NOTHING ELSE.`

const TIER_BONUS_PROMPT = `You write bonus variants for paid creator plans.

Return ONLY valid JSON. No markdown, no code fences.

Rules:
- Keep wording human and conversational.
- Do not use emojis.
- Keep each line concise and speakable.

For plan "creator", return:
{
  "hookOptions": ["...", "..."],
  "endingOptions": ["...", "..."]
}

For plan "studio", return:
{
  "hookOptions": ["...", "...", "..."],
  "endingOptions": ["...", "...", "..."],
  "captionIdeas": ["...", "...", "..."]
}`

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

app.use(cors({origin: '*', methods:['GET','POST','OPTIONS'], allowedHeaders:['Content-Type']}))
app.use('/api', apiLimiter)
app.post(
  '/api/stripe-webhook',
  webhookLimiter,
  express.raw({ type: 'application/json', limit: '300kb' }),
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
          const customerId = session.customer ? String(session.customer) : null
          let userId =
            sanitizeUuid(session?.metadata?.userId) ??
            sanitizeUuid(session?.client_reference_id)

          if (!userId && customerId) {
            const { data: existingByCustomer, error: existingError } = await supabaseAdmin
              .from('user_subscriptions')
              .select('user_id')
              .eq('stripe_customer_id', customerId)
              .maybeSingle()
            if (existingError) throw existingError
            userId = sanitizeNullableUuid(existingByCustomer?.user_id)
          }

          if (userId) {
            await upsertActiveSubscription(userId, customerId)
          }
          break
        }
        case 'customer.subscription.deleted':
        case 'customer.subscription.updated': {
          const subscription = event.data.object
          const customerId = subscription.customer
            ? String(subscription.customer)
            : null
          const userId =
            sanitizeUuid(subscription?.metadata?.userId) ??
            sanitizeUuid(subscription?.metadata?.user_id)
          const nextStatus = normalizeSubscriptionStatus(subscription.status)

          if (userId) {
            const { error: upsertError } = await supabaseAdmin
              .from('user_subscriptions')
              .upsert(
                {
                  user_id: userId,
                  status: nextStatus,
                  stripe_customer_id: customerId,
                  plan_type:
                    sanitizePlanType(subscription?.metadata?.planType) ??
                    sanitizePlanType(subscription?.metadata?.plan_type) ??
                    PLAN_STARTER,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: 'user_id' },
              )
            if (upsertError) throw upsertError
            break
          }

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
                  status: nextStatus,
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
  let paidPlanType = PLAN_STARTER
  let userCount = 0

  try {
    if (!userId) {
      const guestUsage = getGuestUsage(req.ip)
      if (guestUsage.count >= LOGGED_OUT_LIMIT) {
        return res.status(402).json({
          code: 'LIMIT_REACHED',
          error:
            'Free guest limit reached (3 generations). Sign in or upgrade to continue.',
          count: guestUsage.count,
          limit: LOGGED_OUT_LIMIT,
        })
      }
    } else {
      const subscriptionState = await getSubscriptionState(userId)
      activePaidAccess = activePaidAccess || subscriptionState.isActive
      paidPlanType = subscriptionState.planType

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
        count: guestUsage.count,
        limit: LOGGED_OUT_LIMIT,
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

    const bonus = await maybeGenerateTierBonus({
      story,
      script,
      planType: paidPlanType,
    })

    return res.json({
      script,
      count: userCount,
      limit: FREE_USER_LIMIT,
      isPaid: true,
      planType: paidPlanType,
      bonus,
    })
  } catch (error) {
    console.error('/api/generate failed:', error)
    return res.status(500).json({ error: 'Failed to generate script.' })
  }
})

app.post('/api/create-checkout', checkoutLimiter, async (req, res) => {
  if (!stripe) {
    return res
      .status(500)
      .json({ error: 'Missing STRIPE_SECRET_KEY in environment.' })
  }

  const payload = asPlainObject(req.body)
  const userId = sanitizeUuid(payload.userId)
  const userEmail = sanitizeEmail(payload.userEmail)
  const planType = sanitizePlanType(payload.planType)

  if (!userId || !userEmail || !planType) {
    return res
      .status(400)
      .json({ error: 'userId, userEmail, and valid planType are required.' })
  }

  try {
    await upsertPendingSubscription(userId, planType)

    const baseUrl = sanitizeBaseUrl(
      process.env.APP_URL || req.headers.origin || 'http://localhost:5173',
    )
    const unitAmount = PLAN_PRICING[planType]
    const productName = `ScriptForge ${formatPlanLabel(planType)}`
    const productDescription =
      planType === PLAN_STUDIO
        ? 'Unlimited generations + premium hook/end variants + caption ideas'
        : planType === PLAN_CREATOR
          ? 'Unlimited generations + stronger hooks and ending variants'
          : 'Unlimited Reddit-to-TikTok script generations'

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      client_reference_id: userId,
      customer_email: userEmail,
      success_url: `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?checkout=cancelled`,
      metadata: { userId, planType },
      subscription_data: { metadata: { userId, planType } },
      allow_promotion_codes: true,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: unitAmount,
            recurring: { interval: 'month' },
            product_data: {
              name: productName,
              description: productDescription,
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

function getGuestUsage(ipAddress) {
  const key = ipAddress || 'unknown-ip'
  const now = Date.now()
  const existing = guestGenerationTracker.get(key)

  if (!existing || now - existing.lastReset > THIRTY_DAYS_MS) {
    const freshUsage = { count: 0, lastReset: now }
    guestGenerationTracker.set(key, freshUsage)
    return freshUsage
  }

  return existing
}

async function getSubscriptionState(userId) {
  const { data, error } = await supabaseAdmin
    .from('user_subscriptions')
    .select('status, plan_type')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return {
    isActive: data?.status === 'active',
    planType: sanitizePlanType(data?.plan_type) ?? PLAN_STARTER,
  }
}

async function getUserUsage(userId) {
  const { data, error } = await supabaseAdmin
    .from('user_counts')
    .select('count, last_reset')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  const now = new Date()
  const nowMs = now.getTime()

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

  const lastResetMs = data.last_reset ? new Date(data.last_reset).getTime() : nowMs
  if (nowMs - lastResetMs > THIRTY_DAYS_MS) {
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

function sanitizePlanType(value) {
  const cleaned = sanitizeString(value, 24).toLowerCase()
  if (!VALID_PLAN_TYPES.has(cleaned)) return null
  return cleaned
}

function sanitizeBaseUrl(value) {
  const appBaseUrl = parseHttpUrl(process.env.APP_URL)
  const fallback = appBaseUrl || 'http://localhost:5173'

  if (!value) return fallback

  const candidate = parseHttpUrl(value)
  if (!candidate) return fallback

  if (!appBaseUrl) return candidate
  return candidate === appBaseUrl ? candidate : fallback
}

function parseHttpUrl(value) {
  try {
    const parsed = new URL(String(value))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Invalid protocol.')
    }
    return `${parsed.protocol}//${parsed.host}`
  } catch (_error) {
    return null
  }
}

function normalizeSubscriptionStatus(subscriptionStatus) {
  const cleaned = sanitizeString(subscriptionStatus, 40).toLowerCase()
  return STRIPE_ACTIVE_STATUSES.has(cleaned) ? 'active' : 'inactive'
}

async function updateSubscriptionPlan(userId, planType) {
  const { error } = await supabaseAdmin
    .from('user_subscriptions')
    .update({
      plan_type: planType,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)

  if (error) throw error
}

async function upsertActiveSubscription(userId, customerId) {
  let planType = PLAN_STARTER

  if (customerId) {
    try {
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 5,
      })
      const newest = subscriptions.data?.[0]
      const metadataPlan = sanitizePlanType(newest?.metadata?.planType)
      if (metadataPlan) {
        planType = metadataPlan
      } else {
        const amount =
          newest?.items?.data?.[0]?.price?.unit_amount ?? newest?.plan?.amount
        if (amount === PLAN_PRICING[PLAN_STUDIO]) planType = PLAN_STUDIO
        else if (amount === PLAN_PRICING[PLAN_CREATOR]) planType = PLAN_CREATOR
        else planType = PLAN_STARTER
      }
    } catch (error) {
      console.error('Unable to infer plan from Stripe subscription:', error)
    }
  }

  const { error } = await supabaseAdmin
    .from('user_subscriptions')
    .upsert(
      {
        user_id: userId,
        status: 'active',
        stripe_customer_id: customerId,
        plan_type: planType,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )

  if (error) throw error
}

async function upsertPendingSubscription(userId, planType) {
  const { error } = await supabaseAdmin
    .from('user_subscriptions')
    .upsert(
      {
        user_id: userId,
        status: 'inactive',
        plan_type: planType,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )

  if (error) throw error
}

function formatPlanLabel(planType) {
  if (planType === PLAN_CREATOR) return 'Creator'
  if (planType === PLAN_STUDIO) return 'Studio'
  return 'Starter'
}

async function maybeGenerateTierBonus({ story, script, planType }) {
  if (!openai || planType === PLAN_STARTER) return null

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.8,
      messages: [
        { role: 'system', content: TIER_BONUS_PROMPT },
        {
          role: 'user',
          content: `Plan: ${planType}\n\nStory:\n${story}\n\nScript:\n${script}`,
        },
      ],
      response_format: { type: 'json_object' },
    })

    const raw = response.choices?.[0]?.message?.content?.trim()
    if (!raw) return null

    const parsed = JSON.parse(raw)
    const bonus = {
      hookOptions: sanitizeStringArray(parsed.hookOptions, planType === PLAN_STUDIO ? 3 : 2),
      endingOptions: sanitizeStringArray(
        parsed.endingOptions,
        planType === PLAN_STUDIO ? 3 : 2,
      ),
    }

    if (planType === PLAN_STUDIO) {
      bonus.captionIdeas = sanitizeStringArray(parsed.captionIdeas, 3)
    }

    return bonus
  } catch (error) {
    console.error('Tier bonus generation failed:', error)
    return null
  }
}

function sanitizeStringArray(value, maxItems) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => sanitizeString(item, 220))
    .filter(Boolean)
    .slice(0, maxItems)
}

