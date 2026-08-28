const params = new URLSearchParams(location.search);
const message = {
  type: "grok-mcp-oauth-callback",
  ...(params.get("code") ? { code: params.get("code") } : {}),
  ...(params.get("state") ? { state: params.get("state") } : {}),
  ...(params.get("iss") ? { issuer: params.get("iss") } : {}),
  ...(params.get("error") ? { error: params.get("error") } : {}),
  ...(params.get("error_description") ? { errorDescription: params.get("error_description") } : {}),
};
if (window.opener) {
  window.opener.postMessage(message, location.origin);
  document.querySelector("#status").textContent = "Authorization complete. You can close this window.";
  window.close();
} else {
  document.querySelector("#status").textContent = "The original browser-agent window is unavailable. Return to it and try again.";
}
