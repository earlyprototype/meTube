# OAuth 400 Error - Fix Instructions

## Root Cause

Your current OAuth client is type **"Desktop"** which doesn't support custom redirect URIs with ports in Google Cloud Console. Desktop clients only accept:
- `http://localhost` (port 80 only)
- `urn:ietf:wg:oauth:2.0:oob` (manual copy-paste flow)

## Solution: Convert to Web Application OAuth Client

Follow these steps:

### Step 1: Go to Google Cloud Console
1. Navigate to: https://console.cloud.google.com/apis/credentials?project=metube-484821
2. You should see your current "metube" OAuth client (Desktop type)

### Step 2: Create New Web Application OAuth Client
1. Click **"+ CREATE CREDENTIALS"** at the top
2. Select **"OAuth client ID"**
3. For "Application type", select **"Web application"**
4. Name it: **"metube-web"** (or whatever you prefer)
5. Under **"Authorized redirect URIs"**, click **"+ ADD URI"** and add these:
   - `http://localhost:8080`
   - `http://localhost:3000`
   - `http://localhost`
6. Click **"CREATE"**

### Step 3: Download New Credentials
1. On the credentials page, find your new "metube-web" OAuth client
2. Click the **download icon** (⬇️) on the right side
3. Save the downloaded file as `client_secret.json` in your project root
4. **IMPORTANT:** This will replace your existing `client_secret.json`

### Step 4: Delete Old Tokens
```powershell
Remove-Item tokens.json -ErrorAction SilentlyContinue
```

### Step 5: Test OAuth Flow
```powershell
npx tsx src-ts/manual-test.ts
```

The OAuth flow should now work correctly.

---

## Alternative: Use Port 80 (Not Recommended)

If you want to keep the Desktop client, you'd need to:
1. Change the redirect URI to `http://localhost` (no port)
2. Run the OAuth server on port 80 (requires administrator privileges on Windows)
3. Update `client_secret.json` to only have `["http://localhost"]` as redirect_uris

This is **NOT recommended** because:
- Requires running as administrator
- Port 80 may be in use by other services
- Less flexible than Web Application type

---

## Why This Happened

The previous developer created a Desktop OAuth client, which is designed for native desktop apps that use special redirect URIs. Our application uses a local HTTP server, which requires Web Application OAuth client type to support custom ports.

---

## Verification

After creating the Web Application OAuth client and downloading new credentials:

1. Run diagnostic:
   ```powershell
   npx tsx src-ts/diagnose-oauth.ts
   ```

2. Verify the client ID changed (new Web Application client)

3. Run manual test:
   ```powershell
   npx tsx src-ts/manual-test.ts
   ```

4. Browser should open, authorize, and redirect back successfully

---

**Need help?** The key is ensuring the OAuth client type is "Web application", not "Desktop".
