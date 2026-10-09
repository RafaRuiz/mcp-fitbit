/**
 * Public pages required by the Google OAuth consent screen (Branding):
 * application home page and privacy policy.
 */

import type { AppConfig } from './config.js';

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.6">${body}</body></html>`;
}

export function homePage(config: Pick<AppConfig, 'mcpUrl'>): string {
  return page(
    'Google Health MCP',
    `<h1>Google Health MCP</h1>
<p>A private <a href="https://modelcontextprotocol.io">Model Context Protocol</a> connector that lets Claude read the signed-in user's Google Health (Fitbit) data and log food and water on their behalf.</p>
<p>Access is limited to an allowlist of Google accounts. To use it, add a custom connector in Claude with the URL <code>${config.mcpUrl.href}</code> and sign in with Google.</p>
<p><a href="/privacy">Privacy policy</a></p>`
  );
}

export function privacyPage(): string {
  return page(
    'Privacy policy – Google Health MCP',
    `<h1>Privacy policy</h1>
<p><strong>What this service accesses.</strong> After you sign in with Google and grant consent, this service reads your Google Health data (activity, sleep, health metrics, nutrition, profile and settings) and creates or deletes nutrition and hydration entries, only when Claude calls one of its tools on your request.</p>
<p><strong>What is stored.</strong> The server stores your Google account identifier, email address and the OAuth tokens needed to call the Google Health API on your behalf. Health data is passed through to Claude and is not stored by this service.</p>
<p><strong>Sharing.</strong> Your data is not sold or shared with anyone. It is only sent to Claude, the assistant you connected, in response to your own requests.</p>
<p><strong>Google API Services User Data Policy.</strong> Use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<p><strong>Revoking access and deletion.</strong> You can revoke access at any time from <a href="https://myaccount.google.com/permissions">your Google Account permissions</a> or by disconnecting the connector in Claude. Revoked tokens stop working immediately; ask the operator of this server to delete your stored record.</p>`
  );
}
