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
    bold } from 'discord.js';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { measureMemory } from 'vm';

dotenv.config();

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildModeration,
        IntentsBitField.Flags.GuildMembers,
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
                const member = await guild.members.fetch(userId).catch(() => null);
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
async function syncTimeouts(userId: string, timeoutEnd: number | null, logMessage: string) {
    if (timeoutEnd && timeoutEnd > Date.now()) {
        syncData.timeouts[userId] = timeoutEnd;
    } else {
        delete syncData.timeouts[userId];
        timeoutEnd = null; // Ensure timeoutEnd is null if it's in the past
    }
    saveData();

    let timeoutMsg: string[] = [];
    // Fetch the last guild.
    const lastGuild = Array.from(client.guilds.cache.values()).at(-1);
    for (const guild of client.guilds.cache.values()) {
        try {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member) {
                const currentTimeout = member.communicationDisabledUntilTimestamp ?? null;
                if (currentTimeout !== timeoutEnd) {
                    await member.timeout(timeoutEnd ? timeoutEnd - Date.now() : null, 'Timeout synced from another server.');
                    console.log(`Set timeout for user ${userId} in guild ${guild.id}`);
                    if(timeoutMsg.length == 0) {
                        timeoutMsg.push( `🔄 ${bold('Propagation:')} Synced timeout across the following servers`);
                    }
                    timeoutMsg.push(`   ⏳ Timeout applied to **${member.displayName}** in **${guild.name}** ${time(new Date(), TimestampStyles.RelativeTime)}`);
                }
            }
        } catch (error) {
            // Ignore errors if the member is not in the guild or lacks permissions
        }
    }
    
    timeoutMsg.push(`📅 ${bold('Date:')} ${time(new Date(), 'F')} (UTC)`);
    reportBotStatusToUpdatesChannel(logMessage + '\n' + timeoutMsg.join('\n') + `\u200B\n\u200B`);
    
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
            const member = await guild.members.fetch(userId).catch(() => null);
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

// Event handler for member update (for timeouts and Muted role)
client.on('guildMemberUpdate', async (oldMember: GuildMember | PartialGuildMember, newMember: GuildMember) => {
    const userId = newMember.id;

    // Check for timeout changes
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp ?? null;
    const newTimeout = newMember.communicationDisabledUntilTimestamp ?? null;

    if (oldTimeout !== newTimeout) {
        console.log(`Timeout updated for user ${userId} in guild ${newMember.guild.id}. Syncing timeout.`);
        const logMessage = [
            `🚨 ${bold('Timeout updated for user:')}`,
            `👤 ${bold('Username:')} ${inlineCode(newMember.displayName)}`,
            `🆔 ${bold('User ID:')} ${inlineCode(newMember.id)}`,
            `🏠 ${bold('Guild:')} ${inlineCode(newMember.guild.name)}`,
        ].join('\n');  
        await syncTimeouts(userId, newTimeout, logMessage);
    }

    // Check for role changes (Muted role)
    const hadMutedRole = oldMember.roles.cache.some(role => role.name === MUTED_ROLE_NAME);
    const hasMutedRole = newMember.roles.cache.some(role => role.name === MUTED_ROLE_NAME);

    if (hadMutedRole !== hasMutedRole) {
        if (processingUsers.has(userId)) {
            // Ignore changes made by the bot
            return;
        }

        const originGuildId = newMember.guild.id;

        // If the change happened in the origin guild, we propagate it
        if (
            !syncData.mutedRoles[userId] ||
            syncData.mutedRoles[userId].originGuildId === originGuildId
        ) {
            console.log(`Muted role ${hasMutedRole ? 'added to' : 'removed from'} user ${userId} in guild ${originGuildId}. Syncing Muted role.`);
            const logMessage = [
                `🔇 ${bold('Muted role')} ${hasMutedRole ? 'added to' : 'removed from'} ${bold('user:')}`,
                `👤 ${bold('Username:')} ${inlineCode(newMember.displayName)}`,
                `🆔 ${bold('User ID:')} ${inlineCode(newMember.id)}`,
                `🏠 ${bold('Guild:')} ${inlineCode(newMember.guild.name)}`,
            ].join('\n');            
            await syncMutedRole(userId, hasMutedRole, originGuildId, logMessage);
        } else {
            // Change happened in a non-origin guild, revert the change
            console.log(`Muted role change detected in non-origin guild for user ${userId} in guild ${originGuildId}. Reverting change.`);
            reportBotStatusToUpdatesChannel(`Muted role change detected in non-origin guild for user ${newMember.displayName} in server ${newMember.guild.name}. Reverting change.`);
            const member = newMember;
            let mutedRole = member.guild.roles.cache.find(role => role.name === MUTED_ROLE_NAME);
            if (!mutedRole) {
                // Create the Muted role if it doesn't exist
                mutedRole = await member.guild.roles.create({
                    name: MUTED_ROLE_NAME,
                    permissions: [],
                    reason: 'Muted role created for synchronization.',
                });
                console.log(`Created Muted role in guild ${member.guild.id}`);
                reportBotStatusToUpdatesChannel(`🔇 Created **Muted role** in server **${member.guild.name}** at ${time(new Date(), TimestampStyles.LongDateTime)}`);
            }

            processingUsers.add(userId);
            if (syncData.mutedRoles[userId].muted) {
                // Should be muted, re-add the role
                if (!member.roles.cache.has(mutedRole.id)) {
                    await member.roles.add(mutedRole, 'Re-adding Muted role due to synchronization.');
                    console.log(`Re-added Muted role to user ${userId} in guild ${member.guild.id}`);
                    reportBotStatusToUpdatesChannel(`🔄 Re-added **Muted role** to user **${member.displayName}** in server **${member.guild.name}** at ${time(new Date(), TimestampStyles.LongDateTime)}`);
                }
            } else {
                // Should not be muted, remove the role
                if (member.roles.cache.has(mutedRole.id)) {
                    await member.roles.remove(mutedRole, 'Removing Muted role due to synchronization.');
                    console.log(`Removed Muted role from user ${userId} in guild ${member.guild.id}`);
                    reportBotStatusToUpdatesChannel(`🔇 Removed **Muted role** from user **${member.displayName}** in server **${member.guild.name}** at ${time(new Date(), TimestampStyles.LongDateTime)}`);
                }
            }
            processingUsers.delete(userId);
        }
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

    // Sync timeouts and muted roles
    for (const guild of client.guilds.cache.values()) {
        try {
            const members = await guild.members.fetch();
            for (const member of members.values()) {
                const userId = member.id;

                // Sync timeouts
                let timeoutEnd = member.communicationDisabledUntilTimestamp || null;
                if (timeoutEnd && timeoutEnd <= Date.now()) {
                    // Timeout has expired
                    timeoutEnd = null;
                }
                const storedTimeout = syncData.timeouts[userId] ?? null;
                if (storedTimeout !== timeoutEnd) {
                    // Only sync if the timeout has actually changed
                    console.log(`Discovered timeout change for user ${userId} in guild ${guild.id}. Syncing across all guilds.`);
                    const logMessage = [
                        `🚨 ${bold('Discovered Timeout Change For User:')}`,
                        `👤 ${bold('Username:')} ${inlineCode(member.displayName)}`,
                        `🆔 ${bold('User ID:')} ${inlineCode(member.id)}`,
                        `🏠 ${bold('Guild:')} ${inlineCode(guild.name)}`,
                    ].join('\n');  
                    await syncTimeouts(userId, timeoutEnd, logMessage);
                }

                // Sync Muted role
                const hasMutedRole = member.roles.cache.some(role => role.name === MUTED_ROLE_NAME);
                const storedMutedData = syncData.mutedRoles[userId];

                if (storedMutedData) {
                    if (guild.id === storedMutedData.originGuildId) {
                        // Update syncData if the origin guild's muted status has changed
                        if (storedMutedData.muted !== hasMutedRole) {
                            console.log(`Muted role status changed for user ${userId} in origin guild ${guild.id}. Syncing across all guilds.`);
                            const logMessage = [
                                `🚨 ${bold('Muted Role Status Changed For User:')}`,
                                `👤 ${bold('Username:')} ${inlineCode(member.displayName)}`,
                                `🆔 ${bold('User ID:')} ${inlineCode(member.id)}`,
                                `🏠 ${bold('Guild:')} ${inlineCode(guild.name)}`,
                                `📅 ${bold('Date:')} ${time(new Date(), 'F')} (UTC)`,
                            ].join('\n');
                            reportBotStatusToUpdatesChannel(logMessage);
                        }
                    } else {
                        // Ensure muted status matches the origin guild
                        if (hasMutedRole !== storedMutedData.muted) {
                            console.log(`Correcting Muted role for user ${userId} in guild ${guild.id} to match origin guild.`);
                            reportBotStatusToUpdatesChannel(`🔧 Correcting Muted role for user **${member.displayName}** (ID: ${member.id}) in server **${guild.name}** to match the origin server. Action performed at ${time(new Date(), TimestampStyles.LongDateTime)}.`);
                            processingUsers.add(userId);
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
                            if (storedMutedData.muted) {
                                // Should be muted, add role
                                if (!member.roles.cache.has(mutedRole.id)) {
                                    await member.roles.add(mutedRole, 'Muted role synced from origin guild.');
                                    console.log(`Added Muted role to user ${userId} in guild ${guild.id}`);
                                    reportBotStatusToUpdatesChannel(`🔇 Added Muted role to user **${member.displayName}** (ID: ${member.id}) in server **${guild.name}** at ${time(new Date(), TimestampStyles.LongDateTime)}`);
                                }
                            } else {
                                // Should not be muted, remove role
                                if (member.roles.cache.has(mutedRole.id)) {
                                    await member.roles.remove(mutedRole, 'Muted role synced from origin guild.');
                                    console.log(`Removed Muted role from user ${userId} in guild ${guild.id}`);
                                    reportBotStatusToUpdatesChannel(`🔊 Removed Muted role from user **${member.displayName}** (ID: ${member.id}) in server **${guild.name}** at ${time(new Date(), TimestampStyles.LongDateTime)}`);
                                }
                            }
                            processingUsers.delete(userId);
                        }
                    }
                } else if (hasMutedRole) {
                    // User has Muted role but no record in syncData, set this guild as origin
                    console.log(`Discovered Muted role for user ${userId} in guild ${guild.id}. Setting as origin and syncing.`);
                    const logMessage = [
                        `🔇 ${bold('Muted role')} ${hasMutedRole ? 'added to' : 'removed from'} ${bold('user:')}`,
                        `👤 ${bold('Username:')} ${inlineCode(member.displayName)}`,
                        `🆔 ${bold('User ID:')} ${inlineCode(member.id)}`,
                        `🏠 ${bold('Guild:')} ${inlineCode(guild.name)}`,
                    ].join('\n');    
                    await syncMutedRole(userId, hasMutedRole, guild.id, logMessage);
                }
            }
        } catch (error) {
            console.error(`Failed to fetch members for guild ${guild.id}:`, error);
            reportBotStatusToUpdatesChannel(`Failed to fetch members for server ${guild.id}: ${error}`);
        }
    }
}

// Run periodic sync every minute
setInterval(periodicSync, 60 * 1000);

// Event handler for new guilds
client.on('guildCreate', async (guild) => {
    console.log(`Joined new guild: ${guild.name}`);
    reportBotStatusToUpdatesChannel(`📥 Joined a new server: **${guild.name}** at ${time(new Date(), TimestampStyles.LongDateTime)}`);

    // Fetch all members to populate the cache
    try {
        await guild.members.fetch();
    } catch (error) {
        console.error(`Failed to fetch members for guild ${guild.id}:`, error);
        reportBotStatusToUpdatesChannel(`Failed to fetch members for guild ${guild.name}: ${error}`);
    }

    // Sync bans
    for (const userId in syncData.bans) {
        if (syncData.bans[userId]) {
            try {
                await guild.bans.create(userId, { reason: 'Ban synced upon joining new server.' });
                const member = await guild.members.fetch(userId).catch(() => null);
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
            const member = await guild.members.fetch(userId).catch(() => null);
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
                const member = await guild.members.fetch(userId).catch(() => null);
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

    // Fetch all guild members to ensure member caches are populated
    for (const guild of client.guilds.cache.values()) {
        try {
            await guild.members.fetch();
        } catch (error) {
            console.error(`Failed to fetch members for guild ${guild.id}:`, error);
            reportBotStatusToUpdatesChannel(`Failed to fetch members for server ${guild.name}: ${error}`)
        }
    }

    console.log('Initial data loaded and members fetched.');

    // Run initial sync
    await periodicSync();
});

console.log('Mod Sync Bot starting...');
console.log('- By: Patrick Fischer (Pathin) > https://pathin.me');

client.login(process.env.DISCORD_TOKEN);
