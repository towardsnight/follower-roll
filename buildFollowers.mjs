#!/usr/bin/env node
/*
 * buildFollowers.mjs
 *
 * This script connects to the Twitch Helix API and a published Google
 * Spreadsheet to produce a consolidated JSON feed describing followers,
 * supporters and their roles.  It is designed to run within a GitHub
 * Action on a fixed schedule.  All secrets (CLIENT_ID, ACCESS_TOKEN,
 * BROADCASTER_LOGIN, CLIENT_SECRET, REFRESH_TOKEN) are consumed via
 * environment variables – they are never printed to stdout or written
 * to disk.  The generated JSON is written to `docs/data/followers.json`,
 * which is served by GitHub Pages.
 *
 * Usage: node buildFollowers.mjs
 */

import fs from 'fs/promises';
import path from 'path';

// ---------------------------------------------------------------------------
// Configuration – all sensitive values must come from env variables.  If
// additional variables (CLIENT_SECRET, REFRESH_TOKEN) are present they will
// be used to refresh an expired access token.
const CLIENT_ID = process.env.CLIENT_ID || '';
let ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const BROADCASTER_LOGIN = (process.env.BROADCASTER_LOGIN || '').toLowerCase();
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
const REFRESH_TOKEN = process.env.REFRESH_TOKEN || '';

// Google sheet CSV URL.  If you need to change the sheet simply update
// SHEET_URL.  The sheet should remain public so it can be fetched without
// authentication.
const SHEET_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRfLcoOTBYRzP93HxLn09LNjl2NRL9DZhMp5NW-Yr9lMsEN-cJwIAUwsH2cYrIISU3nXc5RFIlk55Pm/pub?output=csv';

// Utility: determine truthiness for checkbox-like values.  Anything
// resembling "true", "1", "x" or "yes" (case‑insensitive) is considered true.
function truthy(v) {
  return /^(true|1|x|yes)$/i.test((v || '').toString().trim());
}

// Utility: refresh the OAuth token.  Twitch will refuse requests with
// expired or revoked tokens.  If a refresh token is provided we use it,
// otherwise we fall back to an anonymous client_credentials grant.  The
// newly issued access token replaces the ACCESS_TOKEN variable.  This
// function returns nothing but updates the outer scope.
async function refreshAccessToken() {
  if (!CLIENT_ID) return;
  let url;
  const params = new URLSearchParams();
  params.append('client_id', CLIENT_ID);
  if (REFRESH_TOKEN && CLIENT_SECRET) {
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', REFRESH_TOKEN);
    params.append('client_secret', CLIENT_SECRET);
  } else {
    // anonymous client credentials grant
    params.append('grant_type', 'client_credentials');
    if (CLIENT_SECRET) {
      params.append('client_secret', CLIENT_SECRET);
    }
  }
  url = 'https://id.twitch.tv/oauth2/token';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`Failed to refresh access token: ${res.status} ${await res.text()}`);
  }
  const js = await res.json();
  ACCESS_TOKEN = js.access_token;
}

// Helix API wrapper.  Automatically adds Client‑ID and Authorization headers
// and transparently refreshes the token when a 401 is encountered.  Returns
// the parsed JSON response.
async function helix(endpoint, query = '') {
  const url = `https://api.twitch.tv/helix/${endpoint}${query}`;
  const doRequest = async () => {
    const res = await fetch(url, {
      headers: {
        'Client-ID': CLIENT_ID,
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });
    if (res.status === 401) {
      // token expired – attempt refresh and retry once
      await refreshAccessToken();
      return doRequest();
    }
    if (!res.ok) {
      throw new Error(`Helix request failed ${res.status}: ${await res.text()}`);
    }
    return res.json();
  };
  return doRequest();
}

// Retrieve the broadcaster ID from the broadcaster login (username).  Returns
// the user ID string or an empty string if not found.
async function getBroadcasterId() {
  if (!BROADCASTER_LOGIN) return '';
  const js = await helix('users', `?login=${encodeURIComponent(BROADCASTER_LOGIN)}`);
  return js.data?.[0]?.id || '';
}

// Fetch all subscribers and bits leaderboard for the broadcaster.  Returns
// objects: subSet (Set of subscriber logins), giftMap (Map login -> gift count)
// and bitsMap (Map login -> bits score).
async function getSubsAndBits(broadcasterId) {
  const subSet = new Set();
  const giftMap = new Map();
  const bitsMap = new Map();
  if (!broadcasterId) {
    return { subSet, giftMap, bitsMap };
  }

  // Fetch subscriptions with pagination
  let cursor = '';
  do {
    const js = await helix('subscriptions', `?broadcaster_id=${broadcasterId}${cursor ? `&after=${cursor}` : ''}`);
    if (js.data) {
      for (const sub of js.data) {
        const login = (sub.user_login || '').toLowerCase();
        if (login) {
          subSet.add(login);
        }
        // gift subscriptions: accumulate by gifter
        if (sub.is_gift && sub.gifter_login) {
          const g = sub.gifter_login.toLowerCase();
          giftMap.set(g, (giftMap.get(g) || 0) + 1);
        }
      }
    }
    cursor = js.pagination?.cursor || '';
  } while (cursor);

  // Fetch bits leaderboard (top 100 all time)
  const lb = await helix('bits/leaderboard', '?count=100&period=all');
  if (lb.data) {
    for (const entry of lb.data) {
      const login = (entry.user_name || '').toLowerCase();
      if (login) {
        bitsMap.set(login, entry.score);
      }
    }
  }
  return { subSet, giftMap, bitsMap };
}

// Fetch avatars for up to 100 logins per call.  Returns an object mapping
// login -> profile_image_url.  If a login isn’t found the mapping will
// simply omit that entry.
async function fetchAvatars(logins) {
  const avatars = {};
  for (let i = 0; i < logins.length; i += 100) {
    const batch = logins.slice(i, i + 100);
    const query = batch.map((l) => `login=${encodeURIComponent(l)}`).join('&');
    try {
      const js = await helix('users', `?${query}`);
      if (js.data) {
        for (const u of js.data) {
          if (u.login) {
            avatars[u.login.toLowerCase()] = u.profile_image_url;
          }
        }
      }
    } catch (err) {
      // Log the error but continue; avatar missing is non‑fatal
      console.error(`Avatar batch failed: ${err.message}`);
    }
  }
  return avatars;
}

// Parse the CSV from Google Sheets and merge follower rows.  Returns an
// object containing:
//   records: array of follower objects with login, display, days, vip, mod,
//            t2, t3, art, firstFollow, tips, giftsOverride, overrideFlag
async function parseFollowersCSV() {
  const res = await fetch(SHEET_URL);
  if (!res.ok) {
    throw new Error(`Failed to download CSV: ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return [];
  // Determine delimiter: comma or semicolon
  const delim = lines[0].includes(',') ? ',' : ';';
  const headers = lines.shift().split(delim).map((h) => h.toLowerCase().trim());
  const col = (name) => headers.indexOf(name);
  const idxViewer = col('viewer_name');
  const idxDays = col('days');
  const idxVIP = col('vip');
  const idxMod = col('mod');
  const idxTier2 = col('tier2');
  const idxTier3 = col('tier3');
  const idxArt = col('artist');
  const idxFirst = col('first_follow');
  const idxTips = col('tips');
  const idxGiftOverride = col('giftsub');
  const idxOverride = col('override');

  const map = new Map();
  const tipMap = new Map();
  const giftOverrideMap = new Map();
  const overrideSet = new Set();

  const today = Date.now();
  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) continue;
    const parts = line.split(delim);
    const display = (parts[idxViewer] || '').trim();
    if (!display) continue;
    const login = display.toLowerCase();

    // Determine days – either from the explicit days column or computed from
    // first_follow date.  If neither parse cleanly we skip the row.
    let days = undefined;
    if (idxDays >= 0) {
      const dStr = parts[idxDays].trim();
      const dNum = parseInt(dStr, 10);
      if (!Number.isNaN(dNum)) days = dNum;
    }
    if (days === undefined && idxFirst >= 0) {
      const fStr = parts[idxFirst].trim();
      const dt = new Date(fStr);
      if (!Number.isNaN(dt.getTime())) {
        days = Math.floor((today - dt.getTime()) / 864e5);
      }
    }
    if (days === undefined || Number.isNaN(days)) continue;

    // Parse tips – currency values may include $ and commas
    if (idxTips >= 0) {
      const str = (parts[idxTips] || '').replace(/[$,]/g, '');
      const n = parseFloat(str);
      if (!Number.isNaN(n) && n > 0) {
        tipMap.set(login, n);
      }
    }
    // Gift subscription override (if provided in the sheet)
    if (idxGiftOverride >= 0) {
      const gStr = (parts[idxGiftOverride] || '').replace(/[^\d]/g, '');
      const gNum = parseInt(gStr, 10);
      if (!Number.isNaN(gNum) && gNum > 0) {
        giftOverrideMap.set(login, gNum);
      }
    }
    // Avatar override flag
    if (idxOverride >= 0 && truthy(parts[idxOverride])) {
      overrideSet.add(login);
    }
    // Build the record – note that if multiple rows map to the same login
    // we keep the record with the largest days value (longest follower).
    const rec = {
      login,
      display,
      days,
      vip: idxVIP >= 0 && truthy(parts[idxVIP]),
      mod: idxMod >= 0 && truthy(parts[idxMod]),
      t2: idxTier2 >= 0 && truthy(parts[idxTier2]),
      t3: idxTier3 >= 0 && truthy(parts[idxTier3]),
      art: idxArt >= 0 && truthy(parts[idxArt]),
    };
    const existing = map.get(login);
    if (!existing || existing.days < days) {
      map.set(login, rec);
    }
  }
  return { records: Array.from(map.values()), tipMap, giftOverrideMap, overrideSet };
}

async function build() {
  // Retrieve broadcaster ID
  const broadcasterId = await getBroadcasterId();
  // Gather subscribers and bits scores
  const { subSet, giftMap, bitsMap } = await getSubsAndBits(broadcasterId);
  // Download and parse the CSV sheet
  const { records, tipMap, giftOverrideMap, overrideSet } = await parseFollowersCSV();
  // Consolidate into final records array
  // The final structure will include extras for each record.
  // Sort by days descending and assign follower numbers (fNum)
  records.sort((a, b) => b.days - a.days);
  records.forEach((rec, idx) => {
    rec.fNum = idx + 1;
  });
  // Fetch avatars for all logins
  const avatars = await fetchAvatars(records.map((r) => r.login));
  // Build final records array
  const finalRecords = records.map((p) => {
    const login = p.login;
    const date = new Date(Date.now() - p.days * 864e5).toISOString();
    return {
      login,
      display: p.display,
      days: p.days,
      date,
      vip: !!p.vip,
      mod: !!p.mod,
      t2: !!p.t2,
      t3: !!p.t3,
      art: !!p.art,
      fNum: p.fNum,
      sub: subSet.has(login),
      gifts: giftOverrideMap.get(login) || giftMap.get(login) || 0,
      bits: bitsMap.get(login) || 0,
      tips: tipMap.get(login) || 0,
      override: overrideSet.has(login),
      avatar: avatars[login] || '',
    };
  });
  // Build the output object
  const out = {
    generated: new Date().toISOString(),
    records: finalRecords,
  };
  // Ensure data directory exists
  // Write output into the docs/data folder so GitHub Pages can serve it.  Note: GitHub Pages only
  // supports deploying from the root or the `docs` directory, so we place the JSON under
  // docs/data instead of public/data.
  const outDir = path.join('docs', 'data');
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, 'followers.json');
  const json = JSON.stringify(out, null, 2);
  await fs.writeFile(outFile, json, 'utf8');
  console.log(`Generated ${finalRecords.length} records`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});