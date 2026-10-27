import { 
    Client, 
    IntentsBitField, 
    GuildBan, GuildMember, 
    PartialGuildMember, 
    Partials, 
    TextChannel, 
    time, 
    TimestampStyles, 
    subtext, 
    inlineCode, 
    bold,
    AuditLogEvent,
    Guild,
    GuildAuditLogsEntry } from 'discord.js';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        // GuildModeration (not privileged) delivers ban/unban events and audit log entries.
        // The privileged GuildMembers intent is intentionally NOT used, so the bot needs
        // no Discord privileged intent review. Timeouts and the Muted role are picked up
        // from the audit log instead of member updates / full member list scans.
        IntentsBitField.Flags.GuildModeration,
    ],
    partials: [Partials.GuildMember, Partials.User],
});

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'syncData.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

let syncData: {
    bans: { [userId: string]: boolean };
    timeouts: { [userId: string]: number | null };
    mutedRoles: { [userId: string]: { muted: boolean; originGuildId: string } };
} = { bans: {}, timeouts: {}, mutedRoles: {} };

const MUTED_ROLE_NAME = 'Muted';

// Load data from file
function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        const data = fs.readFileSync(DATA_FILE, 'utf-8');
        syncData = JSON.parse(data);
    }
}

// Save data to file
function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(syncData, null, 2));
}

// Set to track users currently being processed
const processingUsers = new Set<string>();

// Sync bans across all guilds
async function syncBans(userId: string, banned: boolean, logMsg: string, originGuild: string) {
    syncData.bans[userId] = banned;
    saveData();

    let bannedMsg: string[] = [];
    for (const guild of client.guilds.cache.values()) {
        try {
            if (banned) {
                await guild.bans.create(userId, { reason: 'Ban synced from another server.' });
                const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
                console.log(`Banned user ${userId} in guild ${guild.id})`);
                if(guild.id != originGuild) {
                    if(bannedMsg.length == 0) {
                        bannedMsg.push( `🔄 ${bold('Propagation:')} Synced ban across the following servers`);
                    }
                    if(member) {
                        bannedMsg.push(`    🚫 Banned **${member?.displayName}** from **${guild.name}** ${time(new Date(), TimestampStyles.RelativeTime)}`);
                    } else {
                        bannedMsg.push(`    🚫 Ban enforced on **${guild.name}** ${time(new Date(), TimestampStyles.RelativeTime)}`);
                    }
                }
            } else {
                const bannedMember = await guild.bans.remove(userId, 'Unban synced from another server.');
                console.log(`Unbanned user ${userId} in guild ${guild.id}`);
                if (bannedMember && (guild.id != originGuild)) {
                    if(bannedMsg.length == 0) {
                        bannedMsg.push( `🔄 ${bold('Propagation:')} Synced unban across the following servers`);
                    }
                    bannedMsg.push(`    🚫 Unbanned **${bannedMember?.displayName}** from **${guild.name}** ${time(new Date(), TimestampStyles.RelativeTime)}`);
                }
            }
        } catch (error) {
            // Ignore errors if the user is not in the guild or already banned/unbanned
        }
    }

    bannedMsg.push(`📅 ${bold('Date:')} ${time(new Date(), 'F')} (UTC)`);
    reportBotStatusToUpdatesChannel(logMsg + '\n' + bannedMsg.join('\n') + `\u200B\n\u200B`);
}

// Sync timeouts across all guilds
async function syncTimeouts(userId: string, timeoutEnd: number | null) {
    if (timeoutEnd && timeoutEnd > Date.now()) {
        syncData.timeouts[userId] = timeoutEnd;
    } else {
        delete syncData.timeouts[userId];
        timeoutEnd = null; // Ensure timeoutEnd is null if it's in the past
    }
    saveData();

    for (const guild of client.guilds.cache.values()) {
        try {
            const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
            if (member) {
                const currentTimeout = member.communicationDisabledUntilTimestamp ?? null;
                if (currentTimeout !== timeoutEnd) {
                    await member.timeout(timeoutEnd ? timeoutEnd - Date.now() : null, 'Timeout synced from another server.');
                    console.log(`Set timeout for user ${userId} in guild ${guild.id}`);
                }
            }
        } catch (error) {
            // Ignore errors if the member is not in the guild or lacks permissions
        }
    }
}

// Sync Muted role across all guilds
async function syncMutedRole(userId: string, muted: boolean, originGuildId: string, logMessage: string) {
    if (processingUsers.has(userId)) return;

    processingUsers.add(userId);
    syncData.mutedRoles[userId] = { muted, originGuildId };
    saveData();

    let mutedRoleMsg: string[] = [];
    // Fetch the last guild.
    const lastGuild = Array.from(client.guilds.cache.values()).at(-1);

    for (const guild of client.guilds.cache.values()) {
        if (guild.id === originGuildId) continue; // Skip the origin guild

        try {
            const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
            if (member) {
                let mutedRole = guild.roles.cache.find(role => role.name === MUTED_ROLE_NAME);
                if (!mutedRole) {
                    // Create the Muted role if it doesn't exist
                    mutedRole = await guild.roles.create({
                        name: MUTED_ROLE_NAME,
                        permissions: [],
                        reason: 'Muted role created for synchronization.',
                    });
                    console.log(`Created Muted role in guild ${guild.id}`);
                    reportBotStatusToUpdatesChannel(`🔇 Created **Muted role** in guild **${guild.name}** - ${time(new Date(), TimestampStyles.RelativeTime)}`);
                }
                if (muted) {
                    if (!member.roles.cache.has(mutedRole.id)) {
                        await member.roles.add(mutedRole, 'Muted role synced from another server.');
                        console.log(`Added Muted role to user ${userId} in guild ${guild.id}`);
                        if(mutedRoleMsg.length == 0) {
                            mutedRoleMsg.push( `🔄 ${bold('Syncing Muted role across servers')}`);
                        }
                        mutedRoleMsg.push(`    🔇 Added **Muted role** to **${member.displayName}** in server **${guild.name}** - ${time(new Date(), TimestampStyles.RelativeTime)}`); 
                    }
                } else {
                    if (member.roles.cache.has(mutedRole.id)) {
                        await member.roles.remove(mutedRole, 'Muted role removed synced from another server.');
                        console.log(`Removed Muted role from user ${userId} in guild ${guild.id}`);
                        if(mutedRoleMsg.length == 0) {
                            mutedRoleMsg.push( `🔄 ${bold('Syncing Muted role across servers')}`);
                        }
                        mutedRoleMsg.push(`    🔇 Removed **Muted role** from user **${member.displayName}** in server **${guild.name}** - ${time(new Date(), TimestampStyles.RelativeTime)}`);
                        
                    }
                }
            }
        } catch (error) {
            // Ignore errors if the member is not in the guild or lacks permissions
        }
    }

    // Send timeout updates.
    mutedRoleMsg.push(`📅 ${bold('Date:')} ${time(new Date(), 'F')} (UTC)`);
    reportBotStatusToUpdatesChannel(logMessage + '\n' + mutedRoleMsg.join('\n') + `\u200B\n\u200B`);
    processingUsers.delete(userId);
}

// Report the bot's operational status to the updates channel for monitoring and tracking purposes.
async function reportBotStatusToUpdatesChannel(updateMessage: string) {
    // Check for empty updates discord channel config entry
    if (isEmptyStr(process.env.BOT_UPDATES_DISCORD_CHANNEL_ID)) {
        return;
    }
    
    // Check for known updates discord channel default config entry
    if (process.env.BOT_UPDATES_DISCORD_CHANNEL_ID == "YOUR_CHANNEL_ID"){
        return;
    }

    try {
        const updatesChannel = client.channels.cache.get(process.env.BOT_UPDATES_DISCORD_CHANNEL_ID!);
        (updatesChannel as TextChannel).send(updateMessage)
    } catch (error) {
        console.log(`Error: ${error} occured when sending status to updates channel`);
    }
}

// Function to check string is empty or not
function isEmptyStr(str?: string) {
    return (!str || str.length === 0 );
}

// Event handler for guild ban add
client.on('guildBanAdd', async (ban: GuildBan) => {
    const userId = ban.user.id;
    if (syncData.bans[userId]) return; // Already banned globally
    console.log(`User ${userId} banned in guild ${ban.guild.id}. Syncing ban across all guilds.`);
    const logMessage = [
        `🚨 ${bold('User Banned:')}`,
        `👤 ${bold('Username:')} ${inlineCode(ban.user.displayName)}`,
        `🆔 ${bold('User ID:')} ${inlineCode(ban.user.id)}`,
        `🏠 ${bold('Guild:')} ${inlineCode(ban.guild.name)}`,
      ].join('\n');    
    await syncBans(userId, true, logMessage, ban.guild.id);
});

// Event handler for guild ban remove
client.on('guildBanRemove', async (ban: GuildBan) => {
    const userId = ban.user.id;
    if (!syncData.bans[userId]) return; // Already unbanned globally

    console.log(`User ${userId} unbanned in guild ${ban.guild.id}. Syncing unban across all guilds.`);
    const logMessage = [
        `🚨 ${bold('User Unbanned:')}`,
        `👤 ${bold('Username:')} ${inlineCode(ban.user.displayName)}`,
        `🆔 ${bold('User ID:')} ${inlineCode(ban.user.id)}`,
        `🏠 ${bold('Guild:')} ${inlineCode(ban.guild.name)}`,
      ].join('\n');    
    await syncBans(userId, false, logMessage, ban.guild.id);
});

// Handle a Muted role change detected in a guild (same logic as before:
// the guild where the mute was first applied is the "origin"; changes there
// propagate, changes made by humans in other guilds get reverted).
async function handleMutedRoleChange(guild: Guild, userId: string, hasMutedRole: boolean) {
    if (processingUsers.has(userId)) {
        // Ignore changes made by the bot
        return;
    }

    const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
    const displayName = member?.displayName ?? userId;
    // No server "owns" the Muted status: a change in any server is synced to all
    // others, like timeouts. The server where the change happened is only stored
    // as the origin so it is skipped when syncing.
    const originGuildId = guild.id;

    console.log(`Muted role ${hasMutedRole ? 'added to' : 'removed from'} user ${userId} in guild ${originGuildId}. Syncing Muted role.`);
    const logMessage = [
        `🔇 ${bold('Muted role')} ${hasMutedRole ? 'added to' : 'removed from'} ${bold('user:')}`,
        `👤 ${bold('Username:')} ${inlineCode(displayName)}`,
        `🆔 ${bold('User ID:')} ${inlineCode(userId)}`,
        `🏠 ${bold('Guild:')} ${inlineCode(guild.name)}`,
    ].join('\n');
    await syncMutedRole(userId, hasMutedRole, originGuildId, logMessage);
}

// Event handler for audit log entries (timeouts and Muted role).
// Replaces the old guildMemberUpdate handler, which required the privileged
// Server Members intent. Requires the "View Audit Log" permission in each server.
client.on('guildAuditLogEntryCreate', async (entry: GuildAuditLogsEntry, guild: Guild) => {
    try {
        // Ignore actions performed by this bot itself (prevents sync loops)
        if (entry.executorId && entry.executorId === client.user?.id) return;

        const userId = entry.targetId;
        if (!userId) return;

        // Timeouts: member update that changed communication_disabled_until
        if (entry.action === AuditLogEvent.MemberUpdate) {
            const change = entry.changes.find(c => c.key === 'communication_disabled_until');
            if (!change) return;

            let timeoutEnd = change.new ? Date.parse(String(change.new)) : null;
            if (timeoutEnd !== null && (isNaN(timeoutEnd) || timeoutEnd <= Date.now())) {
                timeoutEnd = null;
            }

            const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
            const displayName = member?.displayName ?? userId;
            console.log(`Timeout updated for user ${userId} in guild ${guild.id}. Syncing timeout.`);
            await syncTimeouts(userId, timeoutEnd);
            if (timeoutEnd) {
                reportBotStatusToUpdatesChannel(`   ⏳ Timeout applied to **${displayName}** (ID: ${userId}) in **${guild.name}** - ${time(new Date(), TimestampStyles.RelativeTime)}`);
            } else {
                reportBotStatusToUpdatesChannel(`   ⏳ Timeout removed from **${displayName}** (ID: ${userId}) in **${guild.name}** - ${time(new Date(), TimestampStyles.RelativeTime)}`);
            }
            return;
        }

        // Muted role: role update that added/removed a role named MUTED_ROLE_NAME
        if (entry.action === AuditLogEvent.MemberRoleUpdate) {
            let hasMutedRole: boolean | null = null;
            for (const change of entry.changes) {
                const roles = change.new as { id: string; name: string }[] | undefined;
                if (!Array.isArray(roles) || !roles.some(role => role.name === MUTED_ROLE_NAME)) continue;
                if (change.key === '$add') hasMutedRole = true;
                if (change.key === '$remove') hasMutedRole = false;
            }
            if (hasMutedRole === null) return;
            await handleMutedRoleChange(guild, userId, hasMutedRole);
        }
    } catch (error) {
        console.error('Error handling audit log entry:', error);
    }
});

// Periodic sync function
async function periodicSync() {
    // Sync bans
    for (const guild of client.guilds.cache.values()) {
        try {
            const bans = await guild.bans.fetch();
            for (const ban of bans.values()) {
                const userId = ban.user.id;
                if (!syncData.bans[userId]) {
                    console.log(`Discovered new ban for user ${userId} in guild ${guild.id}. Syncing across all guilds.`);
                    const logMessage = [
                        `🚨 ${bold('Discovered New Ban For User:')}`,
                        `👤 ${bold('Username:')} ${inlineCode(ban.user.displayName)}`,
                        `🆔 ${bold('User ID:')} ${inlineCode(ban.user.id)}`,
                        `🏠 ${bold('Guild:')} ${inlineCode(ban.guild.name)}`,
                    ].join('\n');
                    await syncBans(userId, true, logMessage, ban.guild.id);
                }
            }
        } catch (error) {
            console.error(`Failed to fetch bans for guild ${guild.id}:`, error);
            reportBotStatusToUpdatesChannel(`Failed to fetch bans for server ${guild.name}: ${error}`);
        }
    }

    // Timeouts and the Muted role are no longer re-checked here: that needed a full
    // member list scan (privileged Server Members intent). They are synced instantly
    // from the audit log instead. Just clean up expired timeouts in the stored data.
    let pruned = false;
    for (const userId in syncData.timeouts) {
        const end = syncData.timeouts[userId];
        if (!end || end <= Date.now()) {
            delete syncData.timeouts[userId];
            pruned = true;
        }
    }
    if (pruned) saveData();
}

// Run periodic sync every minute
setInterval(periodicSync, 60 * 1000);

// Event handler for new guilds
client.on('guildCreate', async (guild) => {
    console.log(`Joined new guild: ${guild.name}`);
    reportBotStatusToUpdatesChannel(`📥 Joined a new server: **${guild.name}** at ${time(new Date(), TimestampStyles.LongDateTime)}`);

    // Sync bans
    for (const userId in syncData.bans) {
        if (syncData.bans[userId]) {
            try {
                await guild.bans.create(userId, { reason: 'Ban synced upon joining new server.' });
                const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
                console.log(`Banned user ${userId} in new guilds ${guild.id}`);
                reportBotStatusToUpdatesChannel(`🚫 Banned user **${member?.displayName}** (ID: ${member?.id}) in the new server **${guild.name}** at ${time(new Date(), TimestampStyles.LongDateTime)}`);
            } catch (error) {
                // Ignore if the user is already banned
            }
        }
    }

    // Sync timeouts
    for (const userId in syncData.timeouts) {
        try {
            const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
            if (member) {
                await member.timeout(syncData.timeouts[userId]! - Date.now(), 'Timeout synced upon joining new server.');
                console.log(`Set timeout for user ${userId} in guild ${guild.id}`);
                reportBotStatusToUpdatesChannel(`⏳ Applied timeout to user **${member.displayName}** (ID: ${member.id}) in server **${guild.name}** at ${time(new Date(), TimestampStyles.LongDateTime)}`);
            }
        } catch (error) {
            // Ignore errors if the member is not in the guild
        }
    }

    // Sync Muted role
    for (const userId in syncData.mutedRoles) {
        if (syncData.mutedRoles[userId].muted) {
            try {
                const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
                if (member) {
                    let mutedRole = guild.roles.cache.find(role => role.name === MUTED_ROLE_NAME);
                    if (!mutedRole) {
                        // Create the Muted role if it doesn't exist
                        mutedRole = await guild.roles.create({
                            name: MUTED_ROLE_NAME,
                            permissions: [],
                            reason: 'Muted role created for synchronization.',
                        });
                        console.log(`Created Muted role in guild ${guild.id}`);
                        reportBotStatusToUpdatesChannel(`🔇 Created Muted role in server **${guild.name}** at ${time(new Date(), TimestampStyles.LongDateTime)}`);
                    }
                    await member.roles.add(mutedRole, 'Muted role synced upon joining new server.');
                    console.log(`Added Muted role to user ${userId} in guild ${guild.id}`);
                    reportBotStatusToUpdatesChannel(`🔊 Added Muted role to user **${member.displayName}** (ID: ${member.id}) in server **${guild.name}** at ${time(new Date(), TimestampStyles.LongDateTime)}`)
                }
            } catch (error) {
                // Ignore errors if the member is not in the guild
            }
        }
    }
});

// On bot ready
client.once('ready', async () => {
    console.log(`Logged in as ${client.user?.tag}!`);
    loadData();

    console.log('Initial data loaded.');

    // Run initial sync
    await periodicSync();
});

console.log('Mod Sync Bot starting...');
console.log('- By: Patrick Fischer (Pathin) > https://pathin.me');

client.login(process.env.DISCORD_TOKEN);
