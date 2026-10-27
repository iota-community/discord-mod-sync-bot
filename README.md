## How to host

#### Requirements

- docker
- docker compose plugin

1. Create a discord bot.

```
Create a discord bot with the following:

Intents:
None of the privileged intents are needed - leave Presence, Server Members
and Message Content switched OFF. (The bot only uses the non-privileged
Guilds + Guild Moderation intents, so it needs no Discord intent review.)

Permissions:
BAN_MEMBERS
MODERATE_MEMBERS
MANAGE_ROLES
VIEW_AUDIT_LOG
VIEW_CHANNEL
SEND_MESSAGES
```

The bot's role must be above the "Muted" role in every server, so it can add/remove it.

2. Set the bot token in .env

```
DISCORD_TOKEN=YOUR_BOT_TOKEN
```
3. Set the Channel ID where the bot updates will be sent

```
BOT_UPDATES_DISCORD_CHANNEL_ID=YOUR_CHANNEL_ID
```
4. Run the bot via docker

```
docker compose up -d --build
```

5. Join the guilds you want to sync with the bot

## How it works

- **Bans / unbans** are synced instantly via ban events, plus a ban list check every minute (catches anything missed while offline). Bans are applied by user ID, so they also work pre-emptively for people who are not (yet) in the other server.
- **Timeouts** and the **Muted role** are synced instantly via audit log events (needs `VIEW_AUDIT_LOG`). A change in any server (adding or removing) is synced to all others; no server "owns" a mute.
- Known limitation: a timeout or Muted role can only be applied to someone who is already in the other server. If they join that server later, it is not applied on join (that would need the privileged Server Members intent).
