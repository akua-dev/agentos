export type DiscordGatewayDispatch = {
  op: 0;
  t: string;
  s: number;
  d: Record<string, unknown>;
};

export type DiscordChannel = {
  id: string;
  type: number;
  parent_id?: string | null;
  guild_id?: string;
};

export type DiscordExternalEvent = {
  provider: "discord";
  deliveryId: string;
  eventType: string;
  coalesceKey: string;
  actorExternalId?: string;
  payload: DiscordGatewayDispatch;
  requestMetadata: Record<string, string | number>;
};

export interface DiscordExternalEventSink {
  ingest(event: DiscordExternalEvent): Promise<void>;
}

export type DiscordInteractionAcknowledgement = {
  interactionId: string;
  token: string;
  responseType: 5 | 6;
};

export class DiscordEventRouter {
  readonly #guildId: string;
  readonly #managedCategoryIds: Set<string>;
  readonly #sink: DiscordExternalEventSink;
  readonly #acknowledgeInteraction: (
    acknowledgement: DiscordInteractionAcknowledgement,
  ) => Promise<void>;
  readonly #fetchChannel: (
    channelId: string,
  ) => Promise<DiscordChannel | undefined>;
  readonly #channels = new Map<string, DiscordChannel>();
  readonly #acceptedMessageIds = new Set<string>();
  readonly #acceptedMessageOrder: string[] = [];
  #botUserId: string | undefined;

  constructor(
    options: {
      guildId: string;
      managedCategoryIds: string[];
      sink: DiscordExternalEventSink;
      acknowledgeInteraction(
        acknowledgement: DiscordInteractionAcknowledgement,
      ): Promise<void>;
      fetchChannel(channelId: string): Promise<DiscordChannel | undefined>;
    },
  ) {
    this.#guildId = options.guildId;
    this.#managedCategoryIds = new Set(options.managedCategoryIds);
    this.#sink = options.sink;
    this.#acknowledgeInteraction = options.acknowledgeInteraction;
    this.#fetchChannel = options.fetchChannel;
  }

  seedChannels(channels: DiscordChannel[]): void {
    for (const channel of channels) this.#channels.set(channel.id, channel);
  }

  async handle(dispatch: DiscordGatewayDispatch): Promise<boolean> {
    if (dispatch.t === "READY") {
      this.#botUserId = objectId(asObject(dispatch.d.user));
      return false;
    }

    if (
      dispatch.t === "CHANNEL_CREATE" ||
      dispatch.t === "CHANNEL_UPDATE" ||
      dispatch.t === "THREAD_CREATE" ||
      dispatch.t === "THREAD_UPDATE"
    ) {
      const channel = asChannel(dispatch.d);
      if (channel) this.#channels.set(channel.id, channel);
      return false;
    }
    if (dispatch.t === "CHANNEL_DELETE" || dispatch.t === "THREAD_DELETE") {
      const channelId = stringValue(dispatch.d.id);
      if (channelId) this.#channels.delete(channelId);
      return false;
    }

    if (!this.#botUserId) return false;
    if (dispatch.t === "INTERACTION_CREATE") {
      return this.#handleInteraction(dispatch);
    }
    if (!isMessageEvent(dispatch.t)) return false;
    const messageId = stringValue(dispatch.d.id);
    const channelId = stringValue(dispatch.d.channel_id);
    const guildId = stringValue(dispatch.d.guild_id);
    if (!messageId || !channelId) return false;
    if (guildId && guildId !== this.#guildId) return false;

    const author = asObject(dispatch.d.author);
    if (author.bot === true || stringValue(dispatch.d.webhook_id)) return false;
    if (dispatch.t === "MESSAGE_CREATE" && !objectId(author)) return false;

    const managedCategoryId = guildId
      ? await this.#resolveManagedCategory(channelId)
      : undefined;
    const isMention = mentionsUser(dispatch.d.mentions, this.#botUserId);
    const wasAccepted = this.#acceptedMessageIds.has(messageId);
    const relevant = !guildId || Boolean(managedCategoryId) || isMention || wasAccepted;
    if (!relevant) return false;

    const actorExternalId = objectId(author);
    const event: DiscordExternalEvent = {
      provider: "discord",
      deliveryId: deliveryId(dispatch, messageId),
      eventType: dispatch.t,
      coalesceKey: `discord:channel:${channelId}`,
      ...(actorExternalId ? { actorExternalId } : {}),
      payload: dispatch,
      requestMetadata: {
        source: "gateway",
        sequence: dispatch.s,
        ...(guildId ? { guild_id: guildId } : {}),
        channel_id: channelId,
        ...(managedCategoryId
          ? { managed_category_id: managedCategoryId }
          : {}),
      },
    };
    await this.#sink.ingest(event);

    if (dispatch.t === "MESSAGE_DELETE") {
      this.#acceptedMessageIds.delete(messageId);
    } else {
      this.#rememberAcceptedMessage(messageId);
    }
    return true;
  }

  async #handleInteraction(
    dispatch: DiscordGatewayDispatch,
  ): Promise<boolean> {
    const interactionId = stringValue(dispatch.d.id);
    const interactionToken = stringValue(dispatch.d.token);
    const interactionType = dispatch.d.type;
    const channelId = stringValue(dispatch.d.channel_id);
    const guildId = stringValue(dispatch.d.guild_id);
    const data = asObject(dispatch.d.data);
    const delivery = interactionDelivery(stringValue(data.custom_id));
    const actorExternalId =
      objectId(asObject(asObject(dispatch.d.member).user)) ??
      objectId(asObject(dispatch.d.user));
    if (
      !interactionId ||
      !interactionToken ||
      (interactionType !== 3 && interactionType !== 5) ||
      !channelId ||
      !delivery ||
      !actorExternalId
    ) {
      return false;
    }
    if (guildId && guildId !== this.#guildId) return false;

    const managedCategoryId = guildId
      ? await this.#resolveManagedCategory(channelId)
      : undefined;
    if (guildId && !managedCategoryId) return false;

    const payload: DiscordGatewayDispatch = {
      ...dispatch,
      d: { ...dispatch.d, token: "[REDACTED]" },
    };
    await this.#sink.ingest({
      provider: "discord",
      deliveryId: `INTERACTION_CREATE:${interactionId}`,
      eventType: dispatch.t,
      coalesceKey: `discord:channel:${channelId}`,
      actorExternalId,
      payload,
      requestMetadata: {
        source: "gateway",
        sequence: dispatch.s,
        ...(guildId ? { guild_id: guildId } : {}),
        channel_id: channelId,
        ...(managedCategoryId
          ? { managed_category_id: managedCategoryId }
          : {}),
        interaction_delivery: delivery,
        redacted_fields: "d.token",
      },
    });
    await this.#acknowledgeInteraction({
      interactionId,
      token: interactionToken,
      responseType: interactionType === 3 ? 6 : 5,
    });
    return true;
  }

  async #resolveManagedCategory(
    initialChannelId: string,
  ): Promise<string | undefined> {
    let channelId: string | undefined = initialChannelId;
    const visited = new Set<string>();
    for (let depth = 0; channelId && depth < 4; depth += 1) {
      if (this.#managedCategoryIds.has(channelId)) return channelId;
      if (visited.has(channelId)) return undefined;
      visited.add(channelId);
      let channel = this.#channels.get(channelId);
      if (!channel) {
        channel = await this.#fetchChannel(channelId);
        if (channel) this.#channels.set(channel.id, channel);
      }
      if (!channel) return undefined;
      channelId = channel.parent_id ?? undefined;
    }
    return undefined;
  }

  #rememberAcceptedMessage(messageId: string): void {
    if (this.#acceptedMessageIds.has(messageId)) return;
    this.#acceptedMessageIds.add(messageId);
    this.#acceptedMessageOrder.push(messageId);
    if (this.#acceptedMessageOrder.length <= 10_000) return;
    const oldest = this.#acceptedMessageOrder.shift();
    if (oldest) this.#acceptedMessageIds.delete(oldest);
  }
}

function isMessageEvent(eventType: string) {
  return (
    eventType === "MESSAGE_CREATE" ||
    eventType === "MESSAGE_UPDATE" ||
    eventType === "MESSAGE_DELETE"
  );
}

function deliveryId(dispatch: DiscordGatewayDispatch, messageId: string) {
  if (dispatch.t === "MESSAGE_CREATE") return `MESSAGE_CREATE:${messageId}`;
  if (dispatch.t === "MESSAGE_DELETE") return `MESSAGE_DELETE:${messageId}`;
  const revision =
    stringValue(dispatch.d.edited_timestamp) ?? `sequence-${dispatch.s}`;
  return `MESSAGE_UPDATE:${messageId}:${revision}`;
}

function interactionDelivery(value: string | undefined) {
  const match = value?.match(/^agentos:(follow-up|steer|stop):.+$/);
  return match?.[1] as "follow-up" | "steer" | "stop" | undefined;
}

function mentionsUser(value: unknown, userId: string) {
  return (
    Array.isArray(value) &&
    value.some((mention) => objectId(asObject(mention)) === userId)
  );
}

function asChannel(value: Record<string, unknown>): DiscordChannel | undefined {
  const id = stringValue(value.id);
  const type = value.type;
  if (!id || typeof type !== "number") return undefined;
  const parentId = value.parent_id;
  const guildId = stringValue(value.guild_id);
  return {
    id,
    type,
    ...(parentId === null || typeof parentId === "string"
      ? { parent_id: parentId }
      : {}),
    ...(guildId ? { guild_id: guildId } : {}),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function objectId(value: Record<string, unknown>) {
  return stringValue(value.id);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
