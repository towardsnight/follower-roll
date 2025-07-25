# TN Follower Roll

This repository powers the **follower roll** you see during streams on the
`towardsnight` Twitch channel.  It contains two main parts:

* A server‑side build script (`buildFollowers.mjs`) which collects data from
  Twitch and a public Google Sheet, merges it and emits a JSON feed at
  `public/data/followers.json`.  The script runs automatically every
  five minutes via a GitHub Action.
* A front‑end (`public/follower.html`) that reads the prebuilt JSON feed,
  applies your styling preferences, and displays follower cards on screen.

## How it works

1.  **Scheduled build** – The GitHub Actions workflow defined in
    `.github/workflows/build.yml` runs on a cron schedule (`*/5 * * * *`).  It
    checks out the repository, runs the Node script and, if the output has
    changed, commits and pushes the updated `followers.json` back to the repo.
2.  **Data sources** –
    * Twitch Helix API: used to fetch the broadcaster ID, active
      subscriptions (to identify current subs and top gift givers) and the
      bits leaderboard.
    * Google Sheets CSV: a published sheet contains follower names, first
      follow dates, VIP/mod/artist flags, tier overrides, tip amounts,
      gift sub overrides and avatar override flags.  You can edit this
      sheet to curate your roll without touching any code.
3.  **Generated JSON** – The build script writes a file with this shape:

    ```json
    {
      "generated": "2025-07-24T22:00:00Z",
      "records": [
        {
          "login": "exampleuser",
          "display": "ExampleUser",
          "days": 123,
          "date": "2025-03-23T00:00:00.000Z",
          "vip": false,
          "mod": true,
          "t2": false,
          "t3": false,
          "art": false,
          "fNum": 1,
          "sub": true,
          "gifts": 2,
          "bits": 500,
          "tips": 42.50,
          "override": false,
          "avatar": "https://static-cdn.jtvnw.net/..."
        },
        ...
      ]
    }
    ```

    The front‑end uses these fields to render cards, sort by various
    criteria and apply filters without needing to talk to Twitch directly.

## Secrets

The workflow consumes several secrets which you must set up in the
repository settings (`Settings › Secrets and variables › Actions`).  Create
**repository secrets** with these names:

| Secret name      | Value                                                    |
| ---------------- | -------------------------------------------------------- |
| `CLIENT_ID`      | Your Twitch application’s client ID                     |
| `ACCESS_TOKEN`   | An app access token with `channel:read:subscriptions`,
                     `bits:read` and `user:read:follows` scopes               |
| `BROADCASTER_LOGIN` | The broadcaster’s Twitch login (e.g. `towardsnight`) |
| `CLIENT_SECRET`  | *(optional)* client secret used to refresh the token    |
| `REFRESH_TOKEN`  | *(optional)* refresh token for long‑lived access        |

Tokens and secrets are never written to disk or printed in logs.  When a
401 error occurs the build script will attempt to refresh the token using
`CLIENT_SECRET`/`REFRESH_TOKEN` if available, otherwise it falls back to an
anonymous client credentials grant.

## Avatar overrides

You can override the avatar for a specific user by dropping an image into
`public/overridepic/` using the follower’s **login name** as the file name.
For example, to override the avatar for the user `myfan123` you would
create either of these files:

```
public/overridepic/myfan123.jpg
public/overridepic/myfan123.png
```

The front‑end will attempt to load the `.jpg` first.  If it fails, it
will try `.png`, and if that also fails it will fall back to the avatar
URL obtained from Twitch.  Make sure your images are cropped to a square
for best results.

## Local development

To run the build script locally you’ll need Node.js 18 or newer.  Clone
the repository, install any dependencies (there are none currently) and
execute:

```bash
export CLIENT_ID=your_client_id
export ACCESS_TOKEN=your_access_token
export BROADCASTER_LOGIN=towardsnight
node buildFollowers.mjs
```

The script writes `public/data/followers.json`.  You can then open
`public/follower.html` in a browser (served via a simple static server such
as `npx serve public`) and see the roll without making any API calls.

## GitHub Pages

Once this repository is pushed to GitHub, enable **GitHub Pages** in the
repository settings and set the source to the `public/` folder.  The
follower roll will then be accessible at:

```
https://<your‑username>.github.io/follower-roll/follower.html
```

Replace `<your‑username>` with your GitHub account name.  Since the
front‑end fetches its data from `data/followers.json` relative to the
deployed HTML, there is no need for a server – GitHub Pages serves both
files directly.
