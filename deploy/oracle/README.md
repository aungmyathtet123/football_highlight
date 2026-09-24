# Permanent Oracle Cloud deployment

This deployment runs the website, Node processor, FFmpeg renderer, and football
tracking stack on one Ubuntu ARM64 VM. Uploads, job checkpoints, and completed
videos live under `/srv/touchline-data`, not in the Git checkout. Caddy provides
HTTPS and password protection, while systemd restarts both application services
after a crash or reboot.

## 1. Create the free VM

In the Oracle Cloud console:

1. Open **Compute > Instances > Create instance**.
2. Use Ubuntu 24.04 (Canonical) on the **VM.Standard.A1.Flex** shape.
3. Select **2 OCPUs and 12 GB RAM**. This is within the recommended Always Free
   allocation when the tenancy has that capacity.
4. Use a 100-200 GB boot volume. Keep the UI's Always Free eligibility marker.
5. Create or upload an SSH public key and save the private key safely.
6. Assign a reserved public IPv4 address so DNS does not change after a reboot.
7. In the subnet security list (or NSG), allow inbound TCP 22, 80, and 443.
   Do not expose ports 3000 or 8787.

Oracle can report temporary capacity shortages for A1 shapes. Trying another
availability domain or returning later is safer than choosing a paid shape.

## 2. Point a free hostname at the VM

Create a DuckDNS subdomain and set its IPv4 value to the VM's reserved public
IP. Wait until this command returns the same address:

```bash
getent ahostsv4 your-name.duckdns.org
```

HTTPS certificate issuance cannot succeed until ports 80/443 are open and DNS
points to the VM.

## 3. Connect and install

From PowerShell on Windows:

```powershell
ssh -i C:\path\to\oracle-key.key ubuntu@YOUR_PUBLIC_IP
```

On the server:

```bash
git clone https://github.com/aungmyathtet123/football_highlight.git
cd football_highlight
bash scripts/setup-linux.sh
cp deploy/oracle/env.production.example .env
nano .env
```

At minimum, replace the hostname in the first three URL values and set:

- `GEMINI_API_KEY`
- `GOOGLE_CLOUD_PROJECT`
- any language/voice values you want to change

## 4. Add Google Cloud credentials

Use a dedicated Google Cloud service account for this server; do not copy a
personal browser login or commit a JSON key. Upload the JSON file from Windows:

```powershell
scp -i C:\path\to\oracle-key.key C:\path\to\google-service-account.json ubuntu@YOUR_PUBLIC_IP:/tmp/google-service-account.json
```

Then on the VM:

```bash
sudo install -d -o root -g ubuntu -m 0750 /etc/touchline
sudo install -o root -g ubuntu -m 0640 /tmp/google-service-account.json /etc/touchline/google-service-account.json
rm /tmp/google-service-account.json
sudo install -d -o ubuntu -g ubuntu -m 0750 /srv/touchline-data
bash scripts/verify-linux.sh
```

The service account needs access only to the Google services configured for the
project: Vertex AI, Video Intelligence, and Text-to-Speech. Keep billing/quota
alerts enabled in Google Cloud.

## 5. Install the public service

Run this from the repository directory. It asks for a website password without
printing it or storing the clear text:

```bash
bash deploy/oracle/install.sh your-name.duckdns.org touchline
```

Open `https://your-name.duckdns.org`, enter the website login, and upload a
short test video. Completed video URLs use the same HTTPS hostname.

## YouTube publishing

Create one Google web OAuth client and authorize each channel owner separately. Store the downloaded client JSON at `/etc/touchline/youtube-oauth-client.json`, set owner-only permissions, and set these values in `/etc/touchline/touchline.env`:

```env
YOUTUBE_OAUTH_CLIENT_FILE=/etc/touchline/youtube-oauth-client.json
YOUTUBE_OAUTH_REDIRECT_URI=https://your-hostname/youtube/oauth/callback
```

Add the same HTTPS callback to the Google OAuth client. Channel refresh tokens and completed-upload records are stored under `LOCAL_DATA_DIR/youtube` and must remain private.

## Operations

Check health and logs:

```bash
curl -u touchline https://your-name.duckdns.org/health
sudo systemctl status touchline-processor touchline-web caddy
sudo journalctl -u touchline-processor -u touchline-web -f
df -h / /srv/touchline-data
```

Deploy a later Git update:

```bash
bash deploy/oracle/update.sh
```

Back up `/srv/touchline-data` if uploaded sources and outputs must be retained.
The free VM and its local disk are not a backup. Job JSON uses atomic writes and
survives service restarts, so a temporary cloud-capacity wait does not require a
new upload.

## Important limits

- A1 capacity may be temporarily unavailable during VM creation.
- Oracle may reclaim an Always Free VM it classifies as idle under its current
  policy. This workload normally uses CPU and memory, but free infrastructure is
  not an uptime guarantee.
- Two ARM OCPUs are functional but CPU-only tracking and 1080p rendering will be
  slower than a GPU server. Keep `TRACKING_SCENE_CONCURRENCY=2` to avoid memory
  pressure on a 12 GB machine.
- SoccerNet CALF is disabled on ARM64 because its legacy TensorFlow dependency
  is optional and is not required for the Gemini-first discovery flow.
- Only process footage you own or are licensed/authorized to use. Editing does
  not guarantee that a platform will accept a fair-use argument.
