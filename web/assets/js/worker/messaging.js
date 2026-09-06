/* ------------------------------------------------------------------------- *
 * GENERATED FILE — DO NOT EDIT.
 * Built by worker/scripts/build-generated.mjs from worker/src/messaging.js.
 * Edit the source and run: npm run build:generated
 * ------------------------------------------------------------------------- */

/**
 * Outbound messaging.
 *
 * The central rule: **a message is only ever recorded as `sent` if something
 * actually accepted it for delivery.** With no provider configured, messages are
 * written to the outbox as `simulated` and the owner can read exactly what would
 * have gone out. A system that claims to have texted a client when it did not is
 * worse than one that never texts — the owner would stop chasing, and the client
 * would never have heard.
 *
 * Two drivers ship:
 *
 *   simulated   the default. Records intent, sends nothing, says so plainly.
 *   webhook     POSTs the message to a URL the owner configures, which lets a
 *               real provider be wired through Zapier/Make/a Worker of their own
 *               without this codebase taking a dependency on any one vendor.
 *
 * Owner alerts never go through a driver at all: they are in-app, and the
 * dashboard already shows them.
 */

export const DRIVERS = ['simulated', 'webhook'];

export function driverName(env) {
  const configured = String(env.MESSAGING_DRIVER || '').trim().toLowerCase();
  if (configured === 'webhook' && env.MESSAGING_WEBHOOK_URL) return 'webhook';
  // Falling back rather than erroring: a half-configured webhook must not stop
  // the engine from recording what it wanted to send.
  return 'simulated';
}

/**
 * Deliver one message.
 * @returns {Promise<{status: 'simulated'|'sent'|'failed', provider: string, error?: string}>}
 */
export async function deliver(env, message) {
  // Owner alerts are surfaced in the app, not pushed anywhere.
  if (message.channel === 'owner_alert') {
    return { status: 'sent', provider: 'in_app' };
  }

  const driver = driverName(env);
  if (driver === 'simulated') {
    return { status: 'simulated', provider: 'simulated' };
  }

  try {
    const res = await fetch(env.MESSAGING_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.MESSAGING_WEBHOOK_SECRET
          ? { Authorization: `Bearer ${env.MESSAGING_WEBHOOK_SECRET}` }
          : {}),
      },
      body: JSON.stringify({
        channel: message.channel,
        to: message.recipient,
        to_name: message.recipient_name,
        subject: message.subject ?? null,
        body: message.body,
        entity_type: message.entity_type ?? null,
        entity_id: message.entity_id ?? null,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        status: 'failed',
        provider: 'webhook',
        error: `Webhook returned ${res.status} ${detail.slice(0, 200)}`.trim(),
      };
    }
    return { status: 'sent', provider: 'webhook' };
  } catch (err) {
    // A failure is recorded as failed, never quietly downgraded to simulated —
    // the owner needs to know the difference between "not wired up" and "wired
    // up and broken".
    return { status: 'failed', provider: 'webhook', error: String(err?.message || err).slice(0, 300) };
  }
}

/**
 * Who a message is actually addressed to.
 *
 * A client with no phone number on file cannot be texted, and pretending
 * otherwise would put a cheerful "reminder sent" in front of an owner whose
 * invoice is still silently unpaid.
 */
export function resolveRecipient(action, ctx) {
  if (action.type === 'notify_owner') {
    return { channel: 'owner_alert', recipient: null, recipient_name: 'Owner', ok: true };
  }

  const channel = action.channel || 'sms';
  const target = action.type === 'message_person' ? ctx.person : ctx.client;
  const address = channel === 'email' ? target?.email : target?.phone;

  return {
    channel,
    recipient: address || null,
    recipient_name: target?.name || null,
    ok: !!address,
    reason: address
      ? null
      : `No ${channel === 'email' ? 'email address' : 'phone number'} on file for ${target?.name || 'this recipient'}.`,
  };
}
