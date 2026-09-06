export default {
  async fetch(request, env, context) {
    if (request.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }

    if (!env.LINE_CHANNEL_SECRET || !env.GAS_WEB_APP_URL || !env.GAS_WEBHOOK_SECRET) {
      return new Response("Worker is not configured", { status: 500 });
    }

    const signature = request.headers.get("x-line-signature");
    const rawBody = await request.text();
    if (!signature || !(await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let webhook;
    try {
      webhook = JSON.parse(rawBody);
    } catch (_error) {
      return new Response("Invalid JSON", { status: 400 });
    }

    // LINEにはすぐ200を返し、GASへの転送はバックグラウンドで行う
    context.waitUntil(forwardToGas(webhook, env));
    return new Response("OK", { status: 200 });
  },
};

async function verifyLineSignature(body, signature, channelSecret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  let signatureBytes;
  try {
    signatureBytes = base64ToBytes(signature);
  } catch (_error) {
    return false;
  }

  return crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(body));
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function forwardToGas(webhook, env) {
  const response = await fetch(env.GAS_WEB_APP_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({
      action: "lineWebhook",
      webhookSecret: env.GAS_WEBHOOK_SECRET,
      webhook,
    }),
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`GAS forwarding failed: ${response.status}`);
  }
}
