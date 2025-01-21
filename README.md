## How to host

#### Requirements

- docker
- docker compose plugin

1. Create a discord bot.

```
Create a discord bot with the following:

Intents:
Server Members Intent (GUILD_MEMBERS)

Permissions:
MANAGE_ROLES
MODERATE_MEMBERS
BAN_MEMBERS
SEND_MESSAGES
```

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
