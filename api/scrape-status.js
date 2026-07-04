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

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

async function githubApi(path) {
  const token = requiredEnv("GITHUB_TOKEN");
  const owner = requiredEnv("GITHUB_OWNER");
  const repo = requiredEnv("GITHUB_REPO");
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "yoco-pulse-vercel",
      },
    }
  );
  return response;
}

module.exports = async (req, res) => {
  if (!cors(req, res)) return json(res, 403, { ok: false, error: "Origin not allowed" });
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "Use GET" });

  try {
    // 1. Get the latest workflow run for scrape.yml
    const workflow = process.env.GITHUB_WORKFLOW_FILE || "scrape.yml";
    const runsRes = await githubApi(
      `/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=1&status=completed&status=in_progress&status=queued`
    );
    if (!runsRes.ok) {
      const text = await runsRes.text();
      return json(res, 502, { ok: false, error: `GitHub runs API: ${runsRes.status} ${text.slice(0, 200)}` });
    }

    const runsData = await runsRes.json();
    const run = runsData.workflow_runs && runsData.workflow_runs[0];

    if (!run) {
      return json(res, 200, {
        ok: true,
        status: "no_runs",
        conclusion: null,
        started_at: null,
        elapsed_seconds: 0,
        data: null,
      });
    }

    const startedAt = run.run_started_at || run.created_at;
    const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);

    const result = {
      ok: true,
      status: run.status,           // queued | in_progress | completed
      conclusion: run.conclusion,   // null | success | failure | cancelled
      started_at: startedAt,
      elapsed_seconds: elapsed,
      data: null,
    };

    // 2. If completed successfully, fetch the fresh data via Contents API (no CDN cache)
    if (run.status === "completed" && run.conclusion === "success") {
      try {
        const contentsRes = await githubApi(
          `/contents/data/latest.json?ref=data`
        );
        if (contentsRes.ok) {
          const contentsData = await contentsRes.json();
          if (contentsData.content) {
            const decoded = Buffer.from(contentsData.content, "base64").toString("utf8");
            result.data = JSON.parse(decoded);
          }
        }
      } catch (dataErr) {
        // Non-fatal: return status without data, frontend will fall back to CDN
        console.warn("Could not fetch data via Contents API:", dataErr.message);
      }
    }

    return json(res, 200, result);
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: err.message || "Could not check scrape status",
    });
  }
};
