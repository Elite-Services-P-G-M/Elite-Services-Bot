# NEXUS v0.2

A menu-first Discord operations bot with applications, private support tickets, staff duty controls, DMail, invoice management, audit logging, and a small authenticated CDN API.

## Interaction model

NEXUS is designed around persistent Discord panels. The only slash command is `/nexus-panel`, used by members with **Manage Server** to post one of the interactive panels. Day-to-day actions use buttons and modals.

Available panel types:
- `applications` — Apply button opens a form. Submissions are posted to `APPLICATION_SUBMISSIONS_CHANNEL_ID` with staff-only Approve/Reject buttons.
- `tickets` — Create Ticket opens a private channel. The bot pings configured staff and developer roles. The ticket contains Claim Ticket and Close Ticket buttons; closing requires confirmation.
- `staff` — Start duty, Stop duty, and Status buttons.
- `mail` — Compose DMail with a modal and view your inbox.
- `invoices` — Authorized staff can create invoice records, view recent invoices, and set each status to **In progress** or **Paid**. Marking an invoice Paid privately DMs a payment confirmation to its customer. A Resend receipt button is available for paid invoices.
- `cdn` — Displays API/CDN information. Actual file uploads use the authenticated API.

## Requirements

- Node.js 20+
- A Discord application and bot
- A server where the bot is installed with `bot` and `applications.commands` scopes

## Setup

1. Extract the ZIP.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Fill in `DISCORD_TOKEN`, `CLIENT_ID`, and `GUILD_ID`.
5. Add role IDs to `STAFF_ROLE_IDS` and `DEVELOPER_ROLE_IDS` (comma-separated).
6. Set `APPLICATION_SUBMISSIONS_CHANNEL_ID` to a private staff-only text channel. This is where completed applications are delivered.
7. Optionally set `AUDIT_CHANNEL_ID` and `TICKET_CATEGORY_ID`. **Important:** `TICKET_CATEGORY_ID` must be the ID of a Discord *category*, not a text channel. If it is missing, deleted, or points to a normal channel, NEXUS now logs a clear warning and creates the ticket outside a category instead of failing.
8. Run `npm run register` once, then `npm start`.
9. In Discord, run `/nexus-panel` and choose which panel to post in the appropriate channel.

## Discord permissions

Invite the bot with the `bot` and `applications.commands` scopes. It needs View Channels, Send Messages, Embed Links, Read Message History, Manage Channels, and Use Application Commands. It needs access to the application submissions channel, audit channel, and ticket category. Configure staff/developer role IDs as comma-separated IDs. Both staff and developer roles receive private ticket access and can claim/close tickets. The bot needs Manage Channels and View Channels permissions; make sure the configured role IDs actually exist in the server.

Keep the application submissions channel private. The bot will not publish application answers in the public panel channel.

## Invoice workflow

1. Create an invoice from the Invoices panel. Enter the amount in minor units (for example, `1250` means `12.50`), a three-letter currency code such as `EUR`, the customer Discord user ID, and a description. The customer ID is required so NEXUS knows where to DM the receipt.
2. Open View invoices. Each recent invoice has **In progress** and **Mark Paid** controls.
3. Marking it Paid stores the paid timestamp and sends the customer a private NEXUS payment confirmation. If DMs are unavailable, the invoice remains Paid and staff can retry using **Resend receipt**.
4. Paid invoices cannot be moved back to In progress through the panel.

The status is an administrative record, not payment verification. Only mark an invoice Paid after confirming payment through your actual payment method.

## API / CDN

The API listens on `127.0.0.1:8787` by default. Configure `API_KEY` with a long random secret. Do not post it in Discord or commit `.env`. Do not expose the API publicly without HTTPS and suitable reverse-proxy protections.

## Notes

- Ticket channels are private to the opener, bot, configured staff roles, and configured developer roles.
- A user may have one open ticket at a time.
- Closing a ticket updates the database and deletes the channel after five seconds. Add transcript export before using this for important support records.
- Invoice entries are administrative records only; NEXUS does not process or verify payments. An authorized staff member manually marks an invoice Paid. NEXUS then DMs the customer a payment confirmation, which clearly states that it is not a bank/card processor receipt or an official tax receipt. A Discord DM can fail if the customer blocks DMs; staff can use Resend receipt from the invoice list.
- DMail attempts a Discord DM notification, but the message is also stored in the local database.
- SQLite is stored at `DATABASE_PATH`.

## Feature-level role permissions

NEXUS checks role permissions when an interaction is received. A visible panel is not an authorization grant: members without the required role receive an ephemeral access-denied response, and modal submissions are checked again. Server Administrators bypass feature role checks.

Configure comma-separated Discord role IDs in `.env`:

| Setting | Controls | Default when blank |
|---|---|---|
| `APPLICATION_REVIEWER_ROLE_IDS` | Approve/reject applications | `STAFF_ROLE_IDS` |
| `TICKET_MANAGER_ROLE_IDS` | Claim and close tickets; ticket-channel staff access | `STAFF_ROLE_IDS` + `DEVELOPER_ROLE_IDS` |
| `DUTY_ROLE_IDS` | Staff duty controls | `STAFF_ROLE_IDS` |
| `DMAIL_ROLE_IDS` | Compose and read DMail | `STAFF_ROLE_IDS` |
| `INVOICE_ROLE_IDS` | Create invoices, change invoice status, and resend receipts | `STAFF_ROLE_IDS` |
| `CDN_ROLE_IDS` | CDN information panel | `DEVELOPER_ROLE_IDS` |
| `PANEL_MANAGER_ROLE_IDS` | Publish NEXUS panels | `STAFF_ROLE_IDS` |

Put multiple role IDs in one setting separated by commas. A member needs at least one listed role. Leave a feature setting blank to use its documented default. If both the setting and its fallback role list are empty, only Server Administrators can use that feature. Application submission and ticket creation remain available to everyone; application review and ticket management are restricted.

The CDN HTTP API is separately protected by `API_KEY`; Discord role checks do not authenticate external HTTP clients. Keep that key private.


## Invoice creation (v0.4.1)

Use the Invoices panel and choose **Create invoice**. The modal asks for amount in normal currency units (for example `12.50`), currency code (for example `EUR`), customer Discord user ID, and a description. The customer ID field is required and is used for the private payment confirmation DM. Copy the user's ID from Discord (Developer Mode must be enabled).
