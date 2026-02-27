// ═══════════════════════════════════════════════════════════
// TranscriptAI Backend — server.js
// Werkt met: PocketBase + AssemblyAI + Stripe
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const { AssemblyAI } = require('assemblyai');
const PocketBase = require('pocketbase/cjs');
require('dotenv').config();

const app = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB max
});

// ─── Services initialiseren ───────────────────────────────
const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://localhost:8090');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const assemblyai = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });

const FREE_MINUTES_TOTAL = 20;
const FREE_MINUTES_PER_FILE = 10;

// ─── Middleware ───────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// ─── Auth middleware ──────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await pb.collection('users').getOne(decoded.id);
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sessie verlopen, log opnieuw in' });
  }
}

// ═══════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════

// Registreren
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email en wachtwoord zijn verplicht' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens zijn' });
  }

  try {
    const user = await pb.collection('users').create({
      email,
      password,
      passwordConfirm: password,
      name: name || email.split('@')[0],
      isPro: false,
      isBusiness: false,
      minutesUsed: 0,
    });

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isPro: user.isPro,
        isBusiness: user.isBusiness,
        minutesUsed: user.minutesUsed,
      }
    });
  } catch (e) {
    if (e.message?.includes('already exists')) {
      return res.status(400).json({ error: 'Dit e-mailadres is al in gebruik' });
    }
    res.status(500).json({ error: 'Registratie mislukt: ' + e.message });
  }
});

// Inloggen
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const authData = await pb.collection('users').authWithPassword(email, password);
    const user = authData.record;
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isPro: user.isPro,
        isBusiness: user.isBusiness,
        minutesUsed: user.minutesUsed,
      }
    });
  } catch (e) {
    res.status(401).json({ error: 'E-mailadres of wachtwoord onjuist' });
  }
});

// Huidige gebruiker ophalen
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    name: req.user.name,
    isPro: req.user.isPro,
    isBusiness: req.user.isBusiness,
    minutesUsed: req.user.minutesUsed,
  });
});

// Uitloggen (client verwijdert token zelf)
app.post('/api/auth/logout', (req, res) => {
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// TRANSCRIPTIE ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/transcription/upload', requireAuth, upload.single('file'), async (req, res) => {
  const { language, mode } = req.body;
  const user = req.user;
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'Geen bestand ontvangen' });

  // Controleer Pro functies
  if ((mode === 'speakers' || mode === 'summary') && !user.isPro && !user.isBusiness) {
    return res.status(403).json({ error: 'Speaker Detection en Summary zijn alleen beschikbaar voor Pro gebruikers' });
  }

  // Controleer gratis minuten
  if (!user.isPro && !user.isBusiness && user.minutesUsed >= FREE_MINUTES_TOTAL) {
    return res.status(403).json({ error: `Je hebt je ${FREE_MINUTES_TOTAL} gratis minuten gebruikt. Upgrade naar Pro voor onbeperkt gebruik.` });
  }

  try {
    // Stel AssemblyAI opties in
    const transcriptOptions = {
      audio: file.buffer,
    };

    if (language === 'auto') {
      transcriptOptions.language_detection = true;
    } else {
      transcriptOptions.language_code = language;
    }

    if (mode === 'words') {
      transcriptOptions.punctuate = true;
    }

    if (mode === 'speakers' && (user.isPro || user.isBusiness)) {
      transcriptOptions.speaker_labels = true;
    }

    if (mode === 'summary' && (user.isPro || user.isBusiness)) {
      transcriptOptions.summarization = true;
      transcriptOptions.summary_model = 'informative';
      transcriptOptions.summary_type = 'bullets';
    }

    // Transcribeer
    const transcript = await assemblyai.transcripts.transcribe(transcriptOptions);

    if (transcript.status === 'error') {
      throw new Error(transcript.error || 'Transcriptie mislukt');
    }

    // Bereken gebruikte minuten
    const durationMinutes = transcript.audio_duration ? transcript.audio_duration / 60 : 0;

    // Update minuten voor gratis gebruikers
    let newMinutesUsed = user.minutesUsed;
    if (!user.isPro && !user.isBusiness) {
      newMinutesUsed = Math.round((user.minutesUsed + durationMinutes) * 10) / 10;
      await pb.collection('users').update(user.id, { minutesUsed: newMinutesUsed });
    }

    // Sla op in geschiedenis
    await pb.collection('transcriptions').create({
      user: user.id,
      filename: file.originalname,
      text: transcript.text,
      language: transcript.language_code || language,
      duration: Math.round(durationMinutes * 10) / 10,
      mode: mode,
    });

    res.json({
      transcript,
      minutesUsed: newMinutesUsed,
    });

  } catch (e) {
    console.error('Transcriptie fout:', e);
    res.status(500).json({ error: 'Transcriptie mislukt: ' + e.message });
  }
});

// Geschiedenis ophalen
app.get('/api/transcription/history', requireAuth, async (req, res) => {
  try {
    const records = await pb.collection('transcriptions').getList(1, 50, {
      filter: `user = "${req.user.id}"`,
      sort: '-created',
    });

    res.json({
      history: records.items.map(item => ({
        id: item.id,
        filename: item.filename,
        text: item.text,
        language: item.language,
        duration: item.duration,
        mode: item.mode,
        createdAt: item.created,
      }))
    });
  } catch (e) {
    res.status(500).json({ error: 'Kon geschiedenis niet laden' });
  }
});

// ═══════════════════════════════════════════════════════════
// STRIPE / BETALINGEN ROUTES
// ═══════════════════════════════════════════════════════════

// Maak subscription aan
app.post('/api/payments/create-subscription', requireAuth, async (req, res) => {
  const { paymentMethodId, plan } = req.body;
  const user = req.user;

  try {
    let customerId = user.stripeCustomerId;

    // Maak Stripe klant aan als die er nog niet is
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        payment_method: paymentMethodId,
        invoice_settings: { default_payment_method: paymentMethodId },
      });
      customerId = customer.id;
      await pb.collection('users').update(user.id, { stripeCustomerId: customerId });
    } else {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }

    // Kies het juiste price ID
    const priceId = plan === 'business'
      ? process.env.STRIPE_BUSINESS_PRICE_ID
      : process.env.STRIPE_PRO_PRICE_ID;

    if (!priceId) {
      return res.status(500).json({ error: 'Stripe price ID niet geconfigureerd in .env' });
    }

    const trialDays = plan === 'business' ? 14 : 7;

    // Maak subscription
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      trial_period_days: trialDays,
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });

    const clientSecret = subscription.latest_invoice?.payment_intent?.client_secret;

    res.json({
      subscriptionId: subscription.id,
      clientSecret: clientSecret || null,
    });

  } catch (e) {
    console.error('Stripe fout:', e);
    res.status(500).json({ error: e.message });
  }
});

// Bevestig betaling en activeer Pro
app.post('/api/payments/confirm', requireAuth, async (req, res) => {
  const { subscriptionId } = req.body;

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    if (subscription.status === 'active' || subscription.status === 'trialing') {
      const isPro = subscription.items.data[0]?.price?.id === process.env.STRIPE_PRO_PRICE_ID;
      const isBusiness = subscription.items.data[0]?.price?.id === process.env.STRIPE_BUSINESS_PRICE_ID;

      await pb.collection('users').update(req.user.id, {
        isPro: isPro || isBusiness,
        isBusiness: isBusiness,
        stripeSubscriptionId: subscriptionId,
      });

      res.json({ success: true, isPro, isBusiness });
    } else {
      res.status(400).json({ error: 'Betaling nog niet bevestigd' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stripe Webhook (voor automatische verlenging/annulering)
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const users = await pb.collection('users').getList(1, 1, {
        filter: `stripeSubscriptionId = "${subscription.id}"`,
      });
      if (users.items[0]) {
        await pb.collection('users').update(users.items[0].id, {
          isPro: false,
          isBusiness: false,
          stripeSubscriptionId: '',
        });
      }
    }
    res.json({ received: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Server starten ───────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ TranscriptAI backend draait op poort ${PORT}`);
  console.log(`📦 PocketBase: ${process.env.POCKETBASE_URL}`);
  console.log(`🔑 AssemblyAI: ${process.env.ASSEMBLYAI_API_KEY ? 'Geconfigureerd ✓' : '⚠️ Ontbreekt!'}`);
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? 'Geconfigureerd ✓' : '⚠️ Ontbreekt!'}`);
});
