// TEST-ONLY stand-in for the auth API so UI tests don't depend on (or create users in) prod.
// Usage: node e2e/mock-auth-backend.mjs 4100   then run the app with BACKEND_URL=http://127.0.0.1:4100
import http from "node:http";
const port = Number(process.argv[2] ?? 4100);
const user = { id: "u1", username: "fe_test_1792812361556", createdAt: "2026-10-01T00:00:00.000Z" };
http.createServer((req, res) => {
  const json = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const authed = /e2ee_session=ok/.test(req.headers.cookie ?? "");
  if (req.method === "POST" && req.url === "/auth/signin") return json(200, { user }, { "set-cookie": "e2ee_session=ok; Path=/; HttpOnly; SameSite=Lax" });
  if (req.method === "POST" && req.url === "/auth/signout") return json(200, { ok: true }, { "set-cookie": "e2ee_session=; Path=/; Max-Age=0" });
  if (req.url === "/auth/me") return authed ? json(200, { user }) : json(401, { error: "unauthorized", message: "no" });
  json(404, { error: "not_found", message: "no" });
}).listen(port, "127.0.0.1");
