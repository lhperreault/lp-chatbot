# Deploy LP Chatbot to Vercel

## Step 1 - Push to GitHub (2 minutes)
1. Go to github.com -> click New repository
2. Name it lp-chatbot, set to Private, click Create
3. Upload all these files (drag and drop the lp-chatbot folder contents)
4. Click Commit changes

## Step 2 - Deploy to Vercel (2 minutes)
1. Go to vercel.com -> Add New Project
2. Click Import next to your lp-chatbot repo
3. Leave all settings as default -> click Deploy
4. Wait ~60 seconds -> you'll get a URL like lp-chatbot.vercel.app

## Step 3 - Add Environment Variables (3 minutes)
In your Vercel project -> Settings -> Environment Variables, add these:

- OPENAI_API_KEY         -> Your OpenAI key (starts with sk-)
- AIRTABLE_API_KEY       -> Your Airtable personal access token
- AIRTABLE_BASE_ID       -> appqep8mBMzhS6lFt (already set)
- GOOGLE_SERVICE_ACCOUNT_JSON -> See Step 4 below
- GOOGLE_CALENDAR_ID     -> lhppressurewashing@gmail.com

After adding all variables -> Redeploy (Deployments tab -> three dots -> Redeploy)

## Step 4 - Google Calendar Setup (5 minutes)
This lets the bot check your calendar and book appointments.

1. Go to console.cloud.google.com
2. Create a new project (call it "LP Chatbot")
3. Go to APIs and Services -> Enable APIs -> search "Google Calendar API" -> Enable it
4. Go to APIs and Services -> Credentials -> Create Credentials -> Service Account
   - Name it "lp-chatbot-calendar"
   - Click Done
5. Click on the service account -> Keys -> Add Key -> JSON -> download the file
6. Open the JSON file, copy ALL the contents, paste it as the GOOGLE_SERVICE_ACCOUNT_JSON env var in Vercel
7. In the JSON you downloaded, find the "client_email" field (looks like lp-chatbot-calendar@your-project.iam.gserviceaccount.com)
8. Go to Google Calendar -> your calendar settings -> Share with specific people -> paste that email -> give it "Make changes to events" permission

## Step 5 - Add to WordPress (30 seconds)
1. In WordPress -> Appearance -> Theme Editor -> footer.php
2. Paste this line just before the closing body tag:

<script src="https://YOUR_VERCEL_URL/widget.js"></script>

Replace YOUR_VERCEL_URL with your actual Vercel URL (e.g. https://lp-chatbot.vercel.app).

A blue chat bubble will appear in the bottom-right corner of every page.

## Done!
The bot will now:
- Greet visitors and walk them through the quote flow
- Automatically save leads to your Airtable (LP PW Bot -> Main)
- Check your Google Calendar for availability when booking
- Book confirmed appointments directly into your calendar
- Send you an email notification via the Make scenario we already built
