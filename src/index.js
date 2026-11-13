
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const config = require('./config');
const { db, audit } = require('./db');
const createApi = require('./api');

if (!config.token) {
  throw new Error('DISCORD_TOKEN is missing. Copy .env.example to .env and configure it.');
}

// APPLICATION DATABASE MIGRATION

const applicationColumns = db.prepare(
  'PRAGMA table_info(applications)'
).all();

if (!applicationColumns.some(column => column.name === 'application_type')) {
  db.exec(`
    ALTER TABLE applications
    ADD COLUMN application_type TEXT NOT NULL DEFAULT 'staff'
  `);

  console.log('[Elite Services] Added application_type database column.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// PERMISSIONS

const isAdmin = member =>
  !!member && member.permissions?.has(PermissionFlagsBits.Administrator);

const hasAnyRole = (member, ids) =>
  !!member && (
    isAdmin(member) ||
    ids.some(id => member.roles?.cache?.has(id))
  );

// ROLE CONFIGURATION

const staffRoleIds = config.staffRoleIds;
const developerRoleIds = config.developerRoleIds;

const ticketManagerRoleIds = config.ticketManagerRoleIds.length
  ? config.ticketManagerRoleIds
  : [...new Set([...staffRoleIds, ...developerRoleIds])];

const applicationReviewerRoleIds = config.applicationReviewerRoleIds.length
  ? config.applicationReviewerRoleIds
  : staffRoleIds;

const dutyRoleIds = config.dutyRoleIds.length
  ? config.dutyRoleIds
  : staffRoleIds;

const dmailRoleIds = config.dmailRoleIds.length
  ? config.dmailRoleIds
  : staffRoleIds;

const invoiceRoleIds = config.invoiceRoleIds.length
  ? config.invoiceRoleIds
  : staffRoleIds;

const cdnRoleIds = config.cdnRoleIds.length
  ? config.cdnRoleIds
  : developerRoleIds;

const panelManagerRoleIds = config.panelManagerRoleIds.length
  ? config.panelManagerRoleIds
  : staffRoleIds;

const staffAndDevRoles = ticketManagerRoleIds;
const ephemeral = { flags: MessageFlags.Ephemeral };

// HELPERS

const row = (...components) =>
  new ActionRowBuilder().addComponents(...components);

const button = (id, label, style = ButtonStyle.Secondary, emoji) => {
  const builder = new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style);

  if (emoji) builder.setEmoji(emoji);

  return builder;
};

const short = (s, n = 1000) =>
  String(s || '').slice(0, n);

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

// TICKET CATEGORY

async function getTicketCategory(guild) {
  if (!config.ticketCategoryId) return null;

  const candidate = await guild.channels
    .fetch(config.ticketCategoryId)
    .catch(() => null);

  if (!candidate) {
    console.warn(
      `[Elite Services] TICKET_CATEGORY_ID ${config.ticketCategoryId} could not be found. Tickets will be created outside a category.`
    );
    return null;
  }

  if (candidate.type !== ChannelType.GuildCategory) {
    console.warn(
      `[Elite Services] TICKET_CATEGORY_ID ${config.ticketCategoryId} is not a category. Tickets will be created outside a category.`
    );
    return null;
  }

  return candidate.id;
}

// AUDIT LOGGING

async function auditLog(guild, user, action, details = {}) {
  audit(guild?.id, user?.id, action, details);

  if (!config.auditChannelId || !guild) return;

  const channel = await guild.channels
    .fetch(config.auditChannelId)
    .catch(() => null);

  if (channel?.isTextBased()) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle(`Elite Services • ${action}`)
          .setDescription(
            `Actor: <@${user?.id || '0'}>\n${short(JSON.stringify(details), 1400)}`
          )
          .setTimestamp()
      ],
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }
}

// APPLICATION MODALS

function applicationModal(type = 'staff') {
  if (!['developer', 'staff'].includes(type)) {
    throw new Error('Invalid application type.');
  }

  const title = type === 'developer'
    ? 'Developer Application'
    : 'Staff Application';

  const modal = new ModalBuilder()
    .setCustomId(`nexus:application:submit:${type}`)
    .setTitle(title);

  const age = new TextInputBuilder()
    .setCustomId('age_range')
    .setLabel('Age range (do not enter birth date)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(30);

  const experience = new TextInputBuilder()
    .setCustomId('experience')
    .setLabel('Relevant experience')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(900);

  const motivation = new TextInputBuilder()
    .setCustomId('motivation')
    .setLabel(
      type === 'developer'
        ? 'What can you develop for Elite Services?'
        : 'Why do you want to join the staff team?'
    )
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(900);

  return modal.addComponents(
    row(age),
    row(experience),
    row(motivation)
  );
}

// DMAIL

function dmailComposeModal() {
  const modal = new ModalBuilder()
    .setCustomId('nexus:mail:submit')
    .setTitle('Compose DMail');

  const subject = new TextInputBuilder()
    .setCustomId('subject')
    .setLabel('Announcement subject')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const body = new TextInputBuilder()
    .setCustomId('body')
    .setLabel('Announcement message')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(3500);

  return modal.addComponents(
    row(subject),
    row(body)
  );
}

async function sendDMail(guild, sender, subject, body) {
  console.log(`[Elite Services DMail] Fetching members of ${guild.name}...`);

  const members = await guild.members.fetch();

  const recipients = [...members.values()].filter(
    member => !member.user.bot
  );

  let delivered = 0;
  let failed = 0;

  const insertMessage = db.prepare(`
    INSERT INTO dmail (
      guild_id,
      sender_id,
      recipient_id,
      subject,
      body
    )
    VALUES (?, ?, ?, ?, ?)
  `);

  console.log(
    `[Elite Services DMail] Starting campaign for ${recipients.length} members.`
  );

  for (const member of recipients) {
    try {
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setAuthor({
          name: `${guild.name} • Elite Services DMail`,
          iconURL: guild.iconURL() || undefined
        })
        .setTitle(subject)
        .setDescription(body)
        .addFields({
          name: 'Sent by',
          value: sender.tag,
          inline: true
        })
        .setFooter({
          text: `Server: ${guild.name} • Elite Services DMail`
        })
        .setTimestamp();

      await member.send({
        embeds: [embed],
        allowedMentions: { parse: [] }
      });

      delivered++;

      try {
        insertMessage.run(
          guild.id,
          sender.id,
          member.id,
          subject,
          body
        );
      } catch (dbError) {
        console.error(
          `[Elite Services DMail] Database error for ${member.id}:`,
          dbError
        );
      }
    } catch (error) {
      failed++;

      console.warn(
        `[Elite Services DMail] Delivery failed for ${member.id}: ${error.message}`
      );
    }

    await sleep(1100);
  }

  console.log(
    `[Elite Services DMail] Finished. Delivered: ${delivered}, Failed: ${failed}`
  );

  return {
    total: recipients.length,
    delivered,
    failed
  };
}

// PANELS

function panelPayload(type, imageUrl = null) {
  const configs = {
    applications: [
      'Elite Services • Join Our Team',
      'Want to become part of Elite Services? Choose the position you want to apply for below. Our team will review your application.',
      [
        button(
          'nexus:application:open:developer',
          'Developer',
          ButtonStyle.Primary,
          '💻'
        ),
        button(
          'nexus:application:open:staff',
          'Staff',
          ButtonStyle.Secondary,
          '🛡️'
        )
      ]
    ],

    tickets: [
      'Elite Services • Support',
      'Need help? Open a private ticket. Staff and developer roles will be notified automatically.',
      [
        button('nexus:ticket:create', 'Create ticket', ButtonStyle.Primary, '🎫')
      ]
    ],

    staff: [
      'Elite Services • Staff desk',
      'Use the controls to start or end your duty session. Staff access is required.',
      [
        button('nexus:duty:start', 'Go on duty', ButtonStyle.Success),
        button('nexus:duty:stop', 'Go off duty', ButtonStyle.Danger),
        button('nexus:duty:status', 'My status', ButtonStyle.Secondary)
      ]
    ],

    mail: [
      'Elite Services • DMail',
      'Compose and send a server announcement. Staff access is required.',
      [
        button('nexus:mail:send', 'Compose DMail', ButtonStyle.Primary, '✉️'),
        button('nexus:mail:inbox', 'Inbox', ButtonStyle.Secondary, '📥')
      ]
    ],

    invoices: [
      'Elite Services • Invoices',
      'Create and manage invoice records. Authorized staff can mark invoices In progress or Paid. Marking an invoice Paid sends the customer a private payment confirmation; this does not process a payment.',
      [
        button('nexus:invoice:create', 'Create invoice', ButtonStyle.Primary),
        button('nexus:invoice:list', 'View invoices', ButtonStyle.Secondary)
      ]
    ],

    cdn: [
      'Elite Services • CDN',
      `CDN uploads are managed through the authenticated API.
API endpoint: \`http://${config.apiHost}:${config.apiPort}\`
${config.publicCdnBaseUrl
        ? `Public file base: ${config.publicCdnBaseUrl}`
        : 'Set PUBLIC_CDN_BASE_URL to publish file links.'}`,
      [
        button('nexus:cdn:info', 'CDN information', ButtonStyle.Secondary)
      ]
    ]
  };

  const panel = configs[type];

  if (!panel) {
    throw new Error(`Unknown panel type: ${type}`);
  }

  const [title, description, buttons] = panel;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(title)
    .setDescription(description);

  if (type === 'applications' && imageUrl) {
    embed.setImage(imageUrl);
  }

  return {
    embeds: [embed],
    components: [row(...buttons)]
  };
}

// READY

client.once(Events.ClientReady, c => {
  console.log(
    `Elite Services online as ${c.user.tag} • ${c.guilds.cache.size} guild(s)`
  );
});

// MAIN INTERACTION HANDLER

client.on(Events.InteractionCreate, async interaction => {
  try {
    // PANEL PUBLISHING

    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === 'nexus-panel'
    ) {
      const type = interaction.options.getString('panel', true);
      const image = interaction.options.getAttachment('image');

      if (
        type === 'applications' &&
        image &&
        image.contentType &&
        !image.contentType.startsWith('image/')
      ) {
        return interaction.reply({
          content: 'Please upload a valid image file.',
          ...ephemeral
        });
      }

      if (
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) &&
        !hasAnyRole(interaction.member, panelManagerRoleIds)
      ) {
        return interaction.reply({
          content: 'You do not have permission to publish Elite Services panels.',
          ...ephemeral
        });
      }

      const restrictedPanelRoles = {
        staff: dutyRoleIds,
        mail: dmailRoleIds,
        invoices: invoiceRoleIds,
        cdn: cdnRoleIds
      };

      if (
        restrictedPanelRoles[type] &&
        !hasAnyRole(interaction.member, restrictedPanelRoles[type])
      ) {
        return interaction.reply({
          content: 'You do not have the required role to publish this panel.',
          ...ephemeral
        });
      }

      await interaction.channel.send(
        panelPayload(
          type,
          type === 'applications' ? image?.url || null : null
        )
      );

      return interaction.reply({
        content: `The **${type}** panel has been posted in this channel.`,
        ...ephemeral
      });
    }

    // BUTTON HANDLERS

    if (interaction.isButton()) {
      const id = interaction.customId;
      const { guild, user, member, channel } = interaction;

      // DMAIL BUTTONS

      if (id === 'nexus:mail:send') {
        if (!hasAnyRole(member, dmailRoleIds)) {
          return interaction.reply({
            content: 'Access denied: DMail is restricted to authorized staff.',
            ...ephemeral
          });
        }

        return interaction.showModal(dmailComposeModal());
      }

      if (id === 'nexus:mail:inbox') {
        const messages = db.prepare(`
          SELECT *
          FROM dmail
          WHERE guild_id = ?
            AND recipient_id = ?
          ORDER BY id DESC
          LIMIT 10
        `).all(guild.id, user.id);

        if (!messages.length) {
          return interaction.reply({
            content: '📭 Your Elite Services DMail inbox is empty.',
            ...ephemeral
          });
        }

        db.prepare(`
          UPDATE dmail
          SET read_at = CURRENT_TIMESTAMP
          WHERE guild_id = ?
            AND recipient_id = ?
            AND read_at IS NULL
        `).run(guild.id, user.id);

        const embeds = messages.map(message =>
          new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(message.subject)
            .setDescription(message.body)
            .addFields(
              {
                name: 'From',
                value: `<@${message.sender_id}>`,
                inline: true
              },
              {
                name: 'Received',
                value: message.created_at,
                inline: true
              }
            )
            .setFooter({
              text: `DMail #${message.id}`
            })
        );

        return interaction.reply({
          content: `📥 Your latest ${messages.length} DMail message(s):`,
          embeds,
          ...ephemeral
        });
      }

      // APPLICATIONS

      if (
        id === 'nexus:application:open:developer' ||
        id === 'nexus:application:open:staff'
      ) {
        const type = id.endsWith(':developer')
          ? 'developer'
          : 'staff';

        return interaction.showModal(applicationModal(type));
      }

      // TICKETS

      if (id === 'nexus:ticket:create') {
        await interaction.deferReply({ ...ephemeral });

        const existing = db.prepare(`
          SELECT channel_id
          FROM tickets
          WHERE guild_id = ?
            AND opener_id = ?
            AND status = 'open'
        `).get(guild.id, user.id);

        if (existing) {
          const oldChannel = await guild.channels
            .fetch(existing.channel_id)
            .catch(() => null);

          if (oldChannel) {
            return interaction.editReply({
              content: `You already have an open ticket: ${oldChannel}`
            });
          }

          db.prepare(`
            UPDATE tickets
            SET status = 'closed', closed_at = CURRENT_TIMESTAMP
            WHERE channel_id = ?
          `).run(existing.channel_id);
        }

        const safeName = user.username
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '')
          .slice(0, 70) || 'member';

        const validTeamRoleIds = staffAndDevRoles.filter(
          roleId => guild.roles.cache.has(roleId)
        );

        const missingTeamRoleIds = staffAndDevRoles.filter(
          roleId => !guild.roles.cache.has(roleId)
        );

        if (missingTeamRoleIds.length) {
          console.warn(
            `[Elite Services] Missing team roles: ${missingTeamRoleIds.join(', ')}`
          );
        }

        const overwrites = [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles
            ]
          },
          {
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.ReadMessageHistory
            ]
          },
          ...validTeamRoleIds.map(roleId => ({
            id: roleId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory
            ]
          }))
        ];

        const ticketParentId = await getTicketCategory(guild);

        const ticketChannel = await guild.channels.create({
          name: `ticket-${safeName}`.slice(0, 90),
          type: ChannelType.GuildText,
          ...(ticketParentId ? { parent: ticketParentId } : {}),
          permissionOverwrites: overwrites
        });

        const result = db.prepare(`
          INSERT INTO tickets (guild_id, channel_id, opener_id)
          VALUES (?, ?, ?)
        `).run(guild.id, ticketChannel.id, user.id);

        const mentions = validTeamRoleIds
          .map(roleId => `<@&${roleId}>`)
          .join(' ');

        const controls = row(
          button('nexus:ticket:claim', 'Claim ticket', ButtonStyle.Success, '🙋'),
          button('nexus:ticket:close', 'Close ticket', ButtonStyle.Danger, '🔒')
        );

        await ticketChannel.send({
          content: `<@${user.id}> ${mentions}\nA member of the team will be with you shortly.`,
          allowedMentions: {
            users: [user.id],
            roles: validTeamRoleIds
          },
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865F2)
              .setTitle(`Ticket #${result.lastInsertRowid}`)
              .setDescription(
                'Please explain your issue here. Keep all relevant information in this channel.'
              )
          ],
          components: [controls]
        });

        await auditLog(guild, user, 'ticket.create', {
          ticketId: result.lastInsertRowid,
          channelId: ticketChannel.id
        });

        return interaction.editReply({
          content: `Your private ticket is ready: ${ticketChannel}${
            config.ticketCategoryId && !ticketParentId
              ? '\n\nNote: the configured TICKET_CATEGORY_ID is not a valid category, so this ticket was created outside a category.'
              : ''
          }`
        });
      }

      if (id.startsWith('nexus:ticket:')) {
        const ticket = db.prepare(`
          SELECT *
          FROM tickets
          WHERE channel_id = ?
            AND guild_id = ?
            AND status = 'open'
        `).get(channel.id, guild.id);

        if (!ticket) {
          return interaction.reply({
            content: 'This ticket is no longer open.',
            ...ephemeral
          });
        }

        if (!hasAnyRole(member, ticketManagerRoleIds)) {
          return interaction.reply({
            content: 'Access denied: you need an authorized ticket staff/developer role.',
            ...ephemeral
          });
        }

        if (id === 'nexus:ticket:claim') {
          if (ticket.claimed_by) {
            return interaction.reply({
              content: `This ticket is already claimed by <@${ticket.claimed_by}>.`,
              ...ephemeral
            });
          }

          db.prepare(`
            UPDATE tickets SET claimed_by = ? WHERE id = ?
          `).run(user.id, ticket.id);

          await auditLog(guild, user, 'ticket.claim', {
            ticketId: ticket.id
          });

          return interaction.reply({
            content: `Claimed by <@${user.id}>.`,
            allowedMentions: { users: [user.id] }
          });
        }

        if (id === 'nexus:ticket:close') {
          return interaction.reply({
            content: 'Are you sure you want to close this ticket?',
            ...ephemeral,
            components: [
              row(
                button(
                  `nexus:ticket:confirm-close:${ticket.id}`,
                  'Confirm close',
                  ButtonStyle.Danger
                ),
                button(
                  'nexus:ticket:cancel-close',
                  'Cancel',
                  ButtonStyle.Secondary
                )
              )
            ]
          });
        }

        if (id.startsWith('nexus:ticket:confirm-close:')) {
          const ticketId = Number(id.split(':').pop());

          const current = db.prepare(`
            SELECT *
            FROM tickets
            WHERE id = ?
              AND channel_id = ?
              AND status = 'open'
          `).get(ticketId, channel.id);

          if (!current) {
            return interaction.update({
              content: 'This ticket is already closed.',
              components: []
            });
          }

          db.prepare(`
            UPDATE tickets
            SET status = 'closed', closed_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(ticketId);

          await auditLog(guild, user, 'ticket.close', {
            ticketId
          });

          await interaction.update({
            content: 'Ticket closed. This channel will be removed in 5 seconds.',
            components: []
          });

          setTimeout(() => {
            channel.delete('Elite Services ticket closed').catch(() => {});
          }, 5000);

          return;
        }

        if (id === 'nexus:ticket:cancel-close') {
          return interaction.update({
            content: 'Ticket closure cancelled.',
            components: []
          });
        }
      }

      // STAFF DUTY

      if (id.startsWith('nexus:duty:')) {
        if (!hasAnyRole(member, dutyRoleIds)) {
          return interaction.reply({
            content: 'Access denied: the staff duty feature is restricted to its configured role.',
            ...ephemeral
          });
        }

        const active = db.prepare(`
          SELECT *
          FROM duty_sessions
          WHERE guild_id = ?
            AND user_id = ?
            AND ended_at IS NULL
          ORDER BY id DESC
          LIMIT 1
        `).get(guild.id, user.id);

        if (id === 'nexus:duty:start') {
          if (active) {
            return interaction.reply({
              content: 'You are already on duty.',
              ...ephemeral
            });
          }

          const result = db.prepare(`
            INSERT INTO duty_sessions (guild_id, user_id)
            VALUES (?, ?)
          `).run(guild.id, user.id);

          await auditLog(guild, user, 'duty.start', {
            sessionId: result.lastInsertRowid
          });

          return interaction.reply({
            content: '🟢 Duty started.',
            ...ephemeral
          });
        }

        if (id === 'nexus:duty:stop') {
          if (!active) {
            return interaction.reply({
              content: 'You are not currently on duty.',
              ...ephemeral
            });
          }

          db.prepare(`
            UPDATE duty_sessions
            SET ended_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(active.id);

          await auditLog(guild, user, 'duty.stop', {
            sessionId: active.id
          });

          return interaction.reply({
            content: '🔴 Duty ended.',
            ...ephemeral
          });
        }

        return interaction.reply({
          content: active
            ? `🟢 On duty since ${active.started_at} UTC.`
            : '⚪ You are currently off duty.',
          ...ephemeral
        });
      }

      // INVOICES

      if (id.startsWith('nexus:invoice:')) {
        if (!hasAnyRole(member, invoiceRoleIds)) {
          return interaction.reply({
            content: 'Access denied: invoices are restricted to their configured role.',
            ...ephemeral
          });
        }

        if (id === 'nexus:invoice:create') {
          const modal = new ModalBuilder()
            .setCustomId('nexus:invoice:submit')
            .setTitle('Create invoice record');

          modal.addComponents(
            row(
              new TextInputBuilder()
                .setCustomId('amount')
                .setLabel('Amount (e.g. 12.50)')
                .setPlaceholder('12.50')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(15)
            ),
            row(
              new TextInputBuilder()
                .setCustomId('currency')
                .setLabel('Currency (e.g. EUR)')
                .setPlaceholder('EUR')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(3)
            ),
            row(
              new TextInputBuilder()
                .setCustomId('customer')
                .setLabel('Customer Discord ID')
                .setPlaceholder('Paste the customer user ID')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(20)
            ),
            row(
              new TextInputBuilder()
                .setCustomId('description')
                .setLabel('What is this invoice for?')
                .setPlaceholder('Service or item description')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(500)
            )
          );

          return interaction.showModal(modal);
        }

        if (id.startsWith('nexus:invoice:status:')) {
          const [, , , nextStatus, invoiceIdRaw] = id.split(':');
          const invoiceId = Number(invoiceIdRaw);

          if (
            !Number.isSafeInteger(invoiceId) ||
            !['in_progress', 'paid'].includes(nextStatus)
          ) {
            return interaction.reply({
              content: 'Invalid invoice action.',
              ...ephemeral
            });
          }

          const invoice = db.prepare(`
            SELECT *
            FROM invoices
            WHERE id = ? AND guild_id = ?
          `).get(invoiceId, guild.id);

          if (!invoice) {
            return interaction.reply({
              content: 'Invoice not found.',
              ...ephemeral
            });
          }

          if (invoice.status === 'paid' && nextStatus !== 'paid') {
            return interaction.reply({
              content: 'A paid invoice cannot be moved back to In progress.',
              ...ephemeral
            });
          }

          if (invoice.status === 'paid' && nextStatus === 'paid') {
            return interaction.reply({
              content: `Invoice #${invoiceId} is already Paid. Use **Resend receipt** if the customer needs another copy.`,
              ...ephemeral
            });
          }

          if (nextStatus === 'in_progress') {
            if (invoice.status === 'in_progress') {
              return interaction.reply({
                content: `Invoice #${invoiceId} is already In progress.`,
                ...ephemeral
              });
            }

            db.prepare(`
              UPDATE invoices
              SET status = 'in_progress'
              WHERE id = ? AND guild_id = ?
            `).run(invoiceId, guild.id);

            await auditLog(guild, user, 'invoice.status', {
              invoiceId,
              from: invoice.status,
              to: 'in_progress'
            });

            return interaction.reply({
              content: `Invoice #${invoiceId} marked **In progress**.`,
              ...ephemeral
            });
          }

          if (!invoice.customer_id) {
            return interaction.reply({
              content: 'This invoice has no customer Discord ID, so Elite Services cannot deliver a private receipt.',
              ...ephemeral
            });
          }

          if (invoice.status !== 'paid') {
            db.prepare(`
              UPDATE invoices
              SET status = 'paid', paid_at = CURRENT_TIMESTAMP
              WHERE id = ? AND guild_id = ?
            `).run(invoiceId, guild.id);

            await auditLog(guild, user, 'invoice.status', {
              invoiceId,
              from: invoice.status,
              to: 'paid',
              customerId: invoice.customer_id
            });
          }

          const customer = await client.users
            .fetch(invoice.customer_id)
            .catch(() => null);

          if (!customer) {
            return interaction.reply({
              content: `Invoice #${invoiceId} is marked Paid, but the customer account could not be fetched.`,
              ...ephemeral
            });
          }

          const paidAt = db.prepare(`
            SELECT paid_at FROM invoices WHERE id = ?
          `).get(invoiceId)?.paid_at;

          const receipt = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle(`Elite Services • Payment confirmation #${invoiceId}`)
            .setDescription(
              'This is a payment confirmation sent by the server. It is not a bank, card processor, or official tax receipt.'
            )
            .addFields(
              {
                name: 'Amount',
                value: `${(invoice.amount_minor / 100).toFixed(2)} ${invoice.currency}`,
                inline: true
              },
              {
                name: 'Status',
                value: 'PAID',
                inline: true
              },
              {
                name: 'Description',
                value: short(invoice.description, 900)
              },
              {
                name: 'Paid at (UTC)',
                value: paidAt || 'Not available'
              }
            )
            .setFooter({ text: `Elite Services invoice #${invoiceId}` })
            .setTimestamp();

          try {
            await customer.send({ embeds: [receipt] });

            await auditLog(guild, user, 'invoice.receipt.sent', {
              invoiceId,
              customerId: customer.id
            });

            return interaction.reply({
              content: `Invoice #${invoiceId} marked **Paid**. A private receipt was sent to <@${customer.id}>.`,
              ...ephemeral
            });
          } catch {
            return interaction.reply({
              content: `Invoice #${invoiceId} is marked **Paid**, but Discord could not deliver the DM. Use **Resend receipt** if they enable DMs.`,
              ...ephemeral
            });
          }
        }

        if (id.startsWith('nexus:invoice:receipt:')) {
          const invoiceId = Number(id.split(':').pop());

          const invoice = db.prepare(`
            SELECT *
            FROM invoices
            WHERE id = ?
              AND guild_id = ?
              AND status = 'paid'
          `).get(invoiceId, guild.id);

          if (!invoice) {
            return interaction.reply({
              content: 'Paid invoice not found.',
              ...ephemeral
            });
          }

          if (!invoice.customer_id) {
            return interaction.reply({
              content: 'This invoice has no customer Discord ID.',
              ...ephemeral
            });
          }

          const customer = await client.users
            .fetch(invoice.customer_id)
            .catch(() => null);

          if (!customer) {
            return interaction.reply({
              content: 'Could not fetch the customer account.',
              ...ephemeral
            });
          }

          const receipt = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle(`Elite Services • Payment confirmation #${invoiceId}`)
            .setDescription(
              'This is a payment confirmation sent by the server. It is not a bank, card processor, or official tax receipt.'
            )
            .addFields(
              {
                name: 'Amount',
                value: `${(invoice.amount_minor / 100).toFixed(2)} ${invoice.currency}`,
                inline: true
              },
              {
                name: 'Status',
                value: 'PAID',
                inline: true
              },
              {
                name: 'Description',
                value: short(invoice.description, 900)
              },
              {
                name: 'Paid at (UTC)',
                value: invoice.paid_at || 'Not available'
              }
            )
            .setFooter({ text: `Elite Services invoice #${invoiceId}` })
            .setTimestamp();

          try {
            await customer.send({ embeds: [receipt] });

            await auditLog(guild, user, 'invoice.receipt.resent', {
              invoiceId,
              customerId: customer.id
            });

            return interaction.reply({
              content: `Receipt for invoice #${invoiceId} was sent again to <@${customer.id}>.`,
              ...ephemeral
            });
          } catch {
            return interaction.reply({
              content: 'Discord could not deliver the DM. The customer may have DMs disabled.',
              ...ephemeral
            });
          }
        }

        const invoices = db.prepare(`
          SELECT *
          FROM invoices
          WHERE guild_id = ?
          ORDER BY id DESC
          LIMIT 5
        `).all(guild.id);

        if (!invoices.length) {
          return interaction.reply({
            content: 'No invoice records yet.',
            ...ephemeral
          });
        }

        const invoiceRows = invoices.map(invoice => {
          const statusLabel =
            invoice.status === 'paid'
              ? 'PAID'
              : invoice.status === 'in_progress'
                ? 'IN PROGRESS'
                : 'UNPAID';

          const controls = [
            button(
              `nexus:invoice:status:in_progress:${invoice.id}`,
              'In progress',
              ButtonStyle.Primary
            ).setDisabled(
              invoice.status === 'in_progress' ||
              invoice.status === 'paid'
            ),

            button(
              `nexus:invoice:status:paid:${invoice.id}`,
              'Mark Paid',
              ButtonStyle.Success
            ).setDisabled(invoice.status === 'paid')
          ];

          if (invoice.status === 'paid') {
            controls.push(
              button(
                `nexus:invoice:receipt:${invoice.id}`,
                'Resend receipt',
                ButtonStyle.Secondary
              )
            );
          }

          return {
            embed: new EmbedBuilder()
              .setColor(
                invoice.status === 'paid'
                  ? 0x57F287
                  : invoice.status === 'in_progress'
                    ? 0xFEE75C
                    : 0x5865F2
              )
              .setTitle(`Invoice #${invoice.id}`)
              .setDescription(
                `**${(invoice.amount_minor / 100).toFixed(2)} ${invoice.currency}**\n${short(invoice.description, 900)}`
              )
              .addFields(
                {
                  name: 'Customer',
                  value: invoice.customer_id
                    ? `<@${invoice.customer_id}>`
                    : 'Not specified',
                  inline: true
                },
                {
                  name: 'Status',
                  value: statusLabel,
                  inline: true
                },
                {
                  name: 'Created',
                  value: invoice.created_at,
                  inline: true
                }
              )
              .setFooter({
                text: invoice.status === 'paid'
                  ? `Paid at ${invoice.paid_at || 'date unavailable'}`
                  : 'Use the buttons below to update this invoice'
              }),

            row: row(...controls)
          };
        });

        return interaction.reply({
          embeds: invoiceRows.map(item => item.embed),
          components: invoiceRows.map(item => item.row),
          ...ephemeral
        });
      }

      // CDN

      if (id === 'nexus:cdn:info') {
        if (!hasAnyRole(member, cdnRoleIds)) {
          return interaction.reply({
            content: 'Access denied: CDN management is restricted to its configured role.',
            ...ephemeral
          });
        }

        return interaction.reply({
          content: 'The CDN uses the Elite Services API. Uploads require the API key and a multipart field named `file`. Do not share your API key in Discord.',
          ...ephemeral
        });
      }
    }

    // MODAL SUBMISSIONS

    if (interaction.isModalSubmit()) {
      const { guild, user, fields } = interaction;

      // DMAIL SUBMISSION

      if (interaction.customId === 'nexus:mail:submit') {
        if (!guild) {
          return interaction.reply({
            content: 'DMail can only be sent from a server.',
            ...ephemeral
          });
        }

        if (!hasAnyRole(interaction.member, dmailRoleIds)) {
          return interaction.reply({
            content: 'Access denied: DMail is restricted to authorized staff.',
            ...ephemeral
          });
        }

        const subject = fields
          .getTextInputValue('subject')
          .trim();

        const body = fields
          .getTextInputValue('body')
          .trim();

        if (!subject || !body) {
          return interaction.reply({
            content: 'Both the subject and announcement message are required.',
            ...ephemeral
          });
        }

        await interaction.deferReply({ ...ephemeral });

        try {
          const result = await sendDMail(
            guild,
            user,
            subject,
            body
          );

          await auditLog(guild, user, 'dmail.send', {
            subject,
            total: result.total,
            delivered: result.delivered,
            failed: result.failed
          });

          const report = new EmbedBuilder()
            .setColor(
              result.failed === 0 ? 0x57F287 : 0xFEE75C
            )
            .setTitle('Elite Services • DMail Delivery Report')
            .setDescription(`**${subject}**`)
            .addFields(
              {
                name: 'Members discovered',
                value: String(result.total),
                inline: true
              },
              {
                name: 'Delivered',
                value: String(result.delivered),
                inline: true
              },
              {
                name: 'Failed',
                value: String(result.failed),
                inline: true
              }
            )
            .setTimestamp();

          return interaction.editReply({
            content: 'DMail campaign processing completed.',
            embeds: [report]
          });
        } catch (error) {
          console.error('[Elite Services DMail] Campaign error:', error);

          return interaction.editReply({
            content:
              'DMail could not complete because the server member list could not be fetched or another campaign error occurred. Check the console.'
          });
        }
      }

      // APPLICATION SUBMISSION

      if (
        interaction.customId.startsWith('nexus:application:submit:')
      ) {
        if (!guild) {
          return interaction.reply({
            content: 'Applications can only be submitted inside a server.',
            ...ephemeral
          });
        }

        const applicationType = interaction.customId.split(':').pop();

        if (!['developer', 'staff'].includes(applicationType)) {
          return interaction.reply({
            content: 'Invalid application type.',
            ...ephemeral
          });
        }

        await interaction.deferReply({ ...ephemeral });

        const age = fields.getTextInputValue('age_range').trim();
        const experience = fields.getTextInputValue('experience').trim();
        const motivation = fields.getTextInputValue('motivation').trim();

        if (!age || !experience || !motivation) {
          return interaction.editReply({
            content: 'Please complete every application field.'
          });
        }

        const result = db.prepare(`
          INSERT INTO applications
            (guild_id, user_id, application_type, age_range, experience, motivation)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          guild.id,
          user.id,
          applicationType,
          age,
          experience,
          motivation
        );

        const submissionChannel = config.applicationSubmissionsChannelId
          ? await guild.channels
              .fetch(config.applicationSubmissionsChannelId)
              .catch(() => null)
          : null;

        if (!submissionChannel?.isTextBased()) {
          await auditLog(guild, user, 'application.submit', {
            applicationId: result.lastInsertRowid,
            applicationType
          });

          return interaction.editReply({
            content: `Your ${applicationType} application #${result.lastInsertRowid} was saved, but the submissions channel is not configured or accessible. Ask an administrator to set APPLICATION_SUBMISSIONS_CHANNEL_ID.`
          });
        }

        const reviewButtons = row(
          button(
            `nexus:application:approve:${result.lastInsertRowid}`,
            'Approve',
            ButtonStyle.Success
          ),
          button(
            `nexus:application:reject:${result.lastInsertRowid}`,
            'Reject',
            ButtonStyle.Danger
          )
        );

        const positionLabel = applicationType === 'developer'
          ? 'Developer'
          : 'Staff';

        await submissionChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865F2)
              .setTitle(
                `Elite Services • ${positionLabel} Application #${result.lastInsertRowid}`
              )
              .addFields(
                {
                  name: 'Applicant',
                  value: `<@${user.id}>`,
                  inline: true
                },
                {
                  name: 'Position',
                  value: positionLabel,
                  inline: true
                },
                {
                  name: 'Age range',
                  value: short(age, 100),
                  inline: true
                },
                {
                  name: 'Experience',
                  value: short(experience, 1000)
                },
                {
                  name: 'Motivation',
                  value: short(motivation, 1000)
                }
              )
              .setTimestamp()
          ],
          components: [reviewButtons],
          allowedMentions: { users: [] }
        });

        await auditLog(guild, user, 'application.submit', {
          applicationId: result.lastInsertRowid,
          applicationType
        });

        return interaction.editReply({
          content: `Your **${positionLabel}** application was submitted successfully. Reference: #${result.lastInsertRowid}.`
        });
      }

      // INVOICE SUBMISSION

      if (interaction.customId === 'nexus:invoice:submit') {
        if (!hasAnyRole(interaction.member, invoiceRoleIds)) {
          return interaction.reply({
            content: 'Access denied: invoices are restricted to their configured role.',
            ...ephemeral
          });
        }

        const amountInput = fields
          .getTextInputValue('amount')
          .trim()
          .replace(',', '.');

        const amountMajor = Number(amountInput);
        const amount = Math.round(amountMajor * 100);

        const currency = fields
          .getTextInputValue('currency')
          .trim()
          .toUpperCase();

        const customer = fields
          .getTextInputValue('customer')
          .trim()
          .replace(/[<@!>]/g, '');

        const description = fields
          .getTextInputValue('description')
          .trim();

        if (
          !Number.isFinite(amountMajor) ||
          amountMajor <= 0 ||
          !Number.isSafeInteger(amount) ||
          !/^[A-Z]{3}$/.test(currency) ||
          !/^\d{17,20}$/.test(customer) ||
          !description
        ) {
          return interaction.reply({
            content: 'Please enter an amount like `12.50`, a 3-letter currency like `EUR`, a valid Discord user ID, and a description.',
            ...ephemeral
          });
        }

        const customerUser = await client.users
          .fetch(customer)
          .catch(() => null);

        if (!customerUser) {
          return interaction.reply({
            content: 'I could not find that Discord user. Check the ID and try again.',
            ...ephemeral
          });
        }

        const result = db.prepare(`
          INSERT INTO invoices
            (guild_id, created_by, customer_id, amount_minor, currency, description)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          guild.id,
          user.id,
          customer,
          amount,
          currency,
          description
        );

        await auditLog(guild, user, 'invoice.create', {
          invoiceId: result.lastInsertRowid,
          amount,
          currency,
          customerId: customer
        });

        return interaction.reply({
          content:
            `Invoice **#${result.lastInsertRowid}** created for <@${customer}>.\n` +
            `**Amount:** ${(amount / 100).toFixed(2)} ${currency}\n` +
            `**Description:** ${short(description, 300)}\n` +
            `**Status:** Unpaid\n\n` +
            'The customer ID is saved for the private receipt when you mark this invoice Paid.',
          ...ephemeral
        });
      }
    }

    // APPLICATION REVIEW

    if (
      interaction.isButton() &&
      (
        interaction.customId.startsWith('nexus:application:approve:') ||
        interaction.customId.startsWith('nexus:application:reject:')
      )
    ) {
      if (!hasAnyRole(interaction.member, applicationReviewerRoleIds)) {
        return interaction.reply({
          content: 'Access denied: application review is restricted to its configured role.',
          ...ephemeral
        });
      }

      const [, , decision, idRaw] = interaction.customId.split(':');
      const appId = Number(idRaw);

      if (
        !Number.isSafeInteger(appId) ||
        !['approve', 'reject'].includes(decision)
      ) {
        return interaction.reply({
          content: 'Invalid application review action.',
          ...ephemeral
        });
      }

      const decisionValue =
        decision === 'approve' ? 'approved' : 'rejected';

      const app = db.prepare(`
        SELECT *
        FROM applications
        WHERE id = ?
          AND guild_id = ?
          AND status = 'pending'
      `).get(appId, interaction.guildId);

      if (!app) {
        return interaction.reply({
          content: 'This application has already been reviewed or no longer exists.',
          ...ephemeral
        });
      }

      db.prepare(`
        UPDATE applications
        SET status = ?, reviewer_id = ?
        WHERE id = ?
      `).run(
        decisionValue,
        interaction.user.id,
        appId
      );

      await auditLog(
        interaction.guild,
        interaction.user,
        'application.review',
        {
          applicationId: appId,
          applicationType: app.application_type || 'staff',
          applicantId: app.user_id,
          decision: decisionValue
        }
      );

      await interaction.update({
        embeds: [
          EmbedBuilder
            .from(interaction.message.embeds[0])
            .setFooter({
              text: `${decisionValue.toUpperCase()} by ${interaction.user.tag}`
            })
        ],
        components: []
      });

      const applicant = await client.users
        .fetch(app.user_id)
        .catch(() => null);

      if (applicant) {
        const positionLabel = app.application_type === 'developer'
          ? 'Developer'
          : 'Staff';

        await applicant
          .send(`Your Elite Services ${positionLabel} application #${appId} was ${decisionValue}.`)
          .catch(() => {});
      }

      return;
    }

  } catch (error) {
    console.error('Interaction error:', error);

    const payload = {
      content: 'Something went wrong while processing that action. The error has been logged.',
      ...ephemeral
    };

    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  }
});

// API

const api = createApi(client);

api.listen(
  config.apiPort,
  config.apiHost,
  () => {
    console.log(
      `Elite Services API listening on http://${config.apiHost}:${config.apiPort}`
    );
  }
);

// BOT LOGIN

client.login(config.token);
