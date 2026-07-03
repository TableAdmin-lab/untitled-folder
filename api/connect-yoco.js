const sodium = require("libsodium-wrappers");

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};

const cors = (req, res) => {
  const allowed = process.env.ALLOWED_ORIGIN || "*";
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", allowed === "*" ? "*" : allowed);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (allowed !== "*" && origin && origin !== allowed) return false;
  return true;
};

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

async function github(path, options = {}) {
  const token = requiredEnv("GITHUB_TOKEN");
  const owner = requiredEnv("GITHUB_OWNER");
  const repo = requiredEnv("GITHUB_REPO");
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "yoco-pulse-vercel",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status}: ${text.slice(0, 240)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function encryptedSecret(value, publicKey) {
  await sodium.ready;
  const keyBytes = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const valueBytes = sodium.from_string(value);
  const encryptedBytes = sodium.crypto_box_seal(valueBytes, keyBytes);
  return sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);
}

async function putSecret(name, value, publicKey) {
  const encrypted_value = await encryptedSecret(value, publicKey.key);
  await github(`/actions/secrets/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      encrypted_value,
      key_id: publicKey.key_id,
    }),
  });
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  if (!cors(req, res)) return json(res, 403, { ok: false, error: "Origin not allowed" });
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Use POST" });

  try {
    const { email, password } = await readJson(req);
    if (!email || !password) {
      return json(res, 400, { ok: false, error: "Yoco email and password are required" });
    }

    const publicKey = await github("/actions/secrets/public-key");
    await putSecret("YOCO_EMAIL", String(email).trim(), publicKey);
    await putSecret("YOCO_PASSWORD", String(password), publicKey);

    const workflow = process.env.GITHUB_WORKFLOW_FILE || "scrape.yml";
    const ref = process.env.GITHUB_REF || "main";
    await github(`/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
    });

    return json(res, 200, { ok: true, message: "Yoco connected and scrape workflow started" });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: err.message || "Could not connect Yoco",
    });
  }
};
