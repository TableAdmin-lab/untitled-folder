const sodium = require("libsodium-wrappers");

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};

const cors = (req, res) => {
  const allowed = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowed === "*" ? "*" : allowed);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return true;
};

module.exports = async (req, res) => {
  if (!cors(req, res)) return json(res, 403, { ok: false, error: "Origin not allowed" });
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "Use GET" });

  try {
    const token = requiredEnv("GITHUB_TOKEN");
    const owner = requiredEnv("GITHUB_OWNER");
    const repo = requiredEnv("GITHUB_REPO");

    // Fetch data/latest.json from the data branch via GitHub contents API
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/data/latest.json?ref=data`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "yoco-pulse-vercel",
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      return json(res, response.status, {
        ok: false,
        error: `GitHub API error (${response.status}): ${text.slice(0, 240)}`,
      });
    }

    const data = await response.json();
    if (!data.content) {
      return json(res, 500, { ok: false, error: "No content returned from GitHub" });
    }

    // Decode base64 content
    const decodedText = Buffer.from(data.content, "base64").toString("utf8");
    const parsedData = JSON.parse(decodedText);

    return json(res, 200, parsedData);
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: err.message || "Could not fetch latest data",
    });
  }
};
