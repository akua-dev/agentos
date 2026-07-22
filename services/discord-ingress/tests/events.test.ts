import { describe, expect, test } from "bun:test";
import {
  DiscordEventRouter,
  type DiscordExternalEvent,
  type DiscordGatewayDispatch,
  type DiscordInteractionAcknowledgement,
} from "../src/events.ts";

function dispatch(
  eventType: string,
  data: Record<string, unknown>,
  sequence = 42,
): DiscordGatewayDispatch {
  return { op: 0, t: eventType, s: sequence, d: data };
}

function setup() {
  const events: DiscordExternalEvent[] = [];
  const acknowledgements: DiscordInteractionAcknowledgement[] = [];
  const fetched: string[] = [];
  const channels = new Map([
    ["category-agentos", { id: "category-agentos", type: 4, parent_id: null }],
    ["channel-owned", { id: "channel-owned", type: 0, parent_id: "category-agentos" }],
    ["forum-owned", { id: "forum-owned", type: 15, parent_id: "category-agentos" }],
    ["thread-dynamic", { id: "thread-dynamic", type: 11, parent_id: "forum-owned" }],
    ["channel-company", { id: "channel-company", type: 0, parent_id: "category-company" }],
  ]);
  const router = new DiscordEventRouter({
    guildId: "guild-1",
    managedCategoryIds: ["category-agentos"],
    sink: {
      async ingest(event) {
        events.push(event);
      },
    },
    async acknowledgeInteraction(acknowledgement) {
      acknowledgements.push(acknowledgement);
    },
    fetchChannel: async (channelId) => {
      fetched.push(channelId);
      return channels.get(channelId);
    },
  });
  router.seedChannels(
    [...channels.values()].filter(({ id }) => id !== "thread-dynamic"),
  );
  return { acknowledgements, events, fetched, router };
}

describe("Discord external-event routing", () => {
  test("persists a human message in an approved category with its raw dispatch", async () => {
    const { events, router } = setup();
    await router.handle(
      dispatch("READY", { user: { id: "firstmate-bot", bot: true } }, 1),
    );
    const incoming = dispatch("MESSAGE_CREATE", {
      id: "message-1",
      guild_id: "guild-1",
      channel_id: "channel-owned",
      author: { id: "captain-1", bot: false },
      content: "Create a customer-research topic",
      mentions: [],
    });

    expect(await router.handle(incoming)).toBe(true);
    expect(events).toEqual([
      {
        provider: "discord",
        deliveryId: "MESSAGE_CREATE:message-1",
        eventType: "MESSAGE_CREATE",
        coalesceKey: "discord:channel:channel-owned",
        actorExternalId: "captain-1",
        payload: incoming,
        requestMetadata: {
          source: "gateway",
          sequence: 42,
          guild_id: "guild-1",
          channel_id: "channel-owned",
          managed_category_id: "category-agentos",
        },
      },
    ]);
  });

  test("resolves a thread through its parent channel into the managed category", async () => {
    const { events, fetched, router } = setup();
    await router.handle(
      dispatch("READY", { user: { id: "firstmate-bot" } }, 1),
    );

    expect(
      await router.handle(
        dispatch("MESSAGE_CREATE", {
          id: "message-thread",
          guild_id: "guild-1",
          channel_id: "thread-dynamic",
          author: { id: "teammate" },
          content: "Thread update",
          mentions: [],
        }),
      ),
    ).toBe(true);
    expect(fetched).toEqual(["thread-dynamic"]);
    expect(events[0]?.requestMetadata.managed_category_id).toBe(
      "category-agentos",
    );
  });

  test("accepts explicit mentions and direct messages but ignores ordinary observed traffic", async () => {
    const { events, router } = setup();
    await router.handle(
      dispatch("READY", { user: { id: "firstmate-bot" } }, 1),
    );

    expect(
      await router.handle(
        dispatch("MESSAGE_CREATE", {
          id: "ordinary",
          guild_id: "guild-1",
          channel_id: "channel-company",
          author: { id: "teammate" },
          content: "General conversation",
          mentions: [],
        }),
      ),
    ).toBe(false);
    expect(
      await router.handle(
        dispatch("MESSAGE_CREATE", {
          id: "mention",
          guild_id: "guild-1",
          channel_id: "channel-company",
          author: { id: "teammate" },
          content: "<@firstmate-bot> please summarize this",
          mentions: [{ id: "firstmate-bot" }],
        }),
      ),
    ).toBe(true);
    expect(
      await router.handle(
        dispatch("MESSAGE_CREATE", {
          id: "dm",
          channel_id: "dm-channel",
          author: { id: "captain-1" },
          content: "Private decision",
          mentions: [],
        }),
      ),
    ).toBe(true);

    expect(events.map((event) => event.deliveryId)).toEqual([
      "MESSAGE_CREATE:mention",
      "MESSAGE_CREATE:dm",
    ]);
  });

  test("ignores bots, webhooks, other guilds and messages before bot identity is known", async () => {
    const { events, router } = setup();
    const ownedMessage = (overrides: Record<string, unknown>) =>
      dispatch("MESSAGE_CREATE", {
        id: "ignored",
        guild_id: "guild-1",
        channel_id: "channel-owned",
        author: { id: "someone" },
        content: "ignored",
        mentions: [],
        ...overrides,
      });

    expect(await router.handle(ownedMessage({}))).toBe(false);
    await router.handle(
      dispatch("READY", { user: { id: "firstmate-bot" } }, 1),
    );
    expect(
      await router.handle(
        ownedMessage({ author: { id: "other-bot", bot: true } }),
      ),
    ).toBe(false);
    expect(
      await router.handle(ownedMessage({ webhook_id: "webhook-1" })),
    ).toBe(false);
    expect(
      await router.handle(ownedMessage({ guild_id: "guild-2" })),
    ).toBe(false);
    expect(events).toEqual([]);
  });

  test("ignores bot- and webhook-authored interactions before persistence or acknowledgement", async () => {
    const { acknowledgements, events, router } = setup();
    await router.handle(
      dispatch("READY", { user: { id: "firstmate-bot" } }, 1),
    );

    expect(
      await router.handle(
        dispatch("INTERACTION_CREATE", {
          id: "bot-interaction",
          token: "bot-interaction-secret",
          type: 3,
          guild_id: "guild-1",
          channel_id: "channel-owned",
          member: { user: { id: "other-bot", bot: true } },
          data: { custom_id: "agentos:follow-up:bot" },
        }),
      ),
    ).toBe(false);
    expect(
      await router.handle(
        dispatch("INTERACTION_CREATE", {
          id: "webhook-interaction",
          token: "webhook-interaction-secret",
          type: 3,
          guild_id: "guild-1",
          channel_id: "channel-owned",
          webhook_id: "webhook-1",
          member: { user: { id: "human" } },
          data: { custom_id: "agentos:follow-up:webhook" },
        }),
      ),
    ).toBe(false);

    expect(events).toEqual([]);
    expect(acknowledgements).toEqual([]);
  });

  test("keeps relevant edits and deletion in the same conversation batch", async () => {
    const { events, router } = setup();
    await router.handle(
      dispatch("READY", { user: { id: "firstmate-bot" } }, 1),
    );

    expect(
      await router.handle(
        dispatch("MESSAGE_UPDATE", {
          id: "message-1",
          guild_id: "guild-1",
          channel_id: "channel-owned",
          author: { id: "captain-1" },
          edited_timestamp: "2026-07-22T10:00:00.000Z",
          content: "Corrected intent",
        }),
      ),
    ).toBe(true);
    expect(
      await router.handle(
        dispatch("MESSAGE_DELETE", {
          id: "message-1",
          guild_id: "guild-1",
          channel_id: "channel-owned",
        }),
      ),
    ).toBe(true);

    expect(events.map(({ deliveryId, coalesceKey }) => ({ deliveryId, coalesceKey }))).toEqual([
      {
        deliveryId:
          "MESSAGE_UPDATE:message-1:2026-07-22T10:00:00.000Z",
        coalesceKey: "discord:channel:channel-owned",
      },
      {
        deliveryId: "MESSAGE_DELETE:message-1",
        coalesceKey: "discord:channel:channel-owned",
      },
    ]);
  });

  test("tracks an accepted mention so its later edit remains relevant", async () => {
    const { events, router } = setup();
    await router.handle(
      dispatch("READY", { user: { id: "firstmate-bot" } }, 1),
    );
    await router.handle(
      dispatch("MESSAGE_CREATE", {
        id: "mention",
        guild_id: "guild-1",
        channel_id: "channel-company",
        author: { id: "teammate" },
        content: "<@firstmate-bot> initial",
        mentions: [{ id: "firstmate-bot" }],
      }),
    );

    expect(
      await router.handle(
        dispatch("MESSAGE_UPDATE", {
          id: "mention",
          guild_id: "guild-1",
          channel_id: "channel-company",
          edited_timestamp: "2026-07-22T10:01:00.000Z",
          content: "Updated without mention metadata",
        }),
      ),
    ).toBe(true);
    expect(events).toHaveLength(2);
  });

  test("persists a managed component without its temporary reply credential", async () => {
    const { acknowledgements, events, router } = setup();
    await router.handle(
      dispatch("READY", { user: { id: "firstmate-bot" } }, 1),
    );
    const incoming = dispatch("INTERACTION_CREATE", {
      id: "interaction-1",
      token: "interaction-secret",
      type: 3,
      guild_id: "guild-1",
      channel_id: "channel-owned",
      member: { user: { id: "captain-1" } },
      data: {
        component_type: 2,
        custom_id: "agentos:follow-up:decision:release-42",
      },
    });

    expect(await router.handle(incoming)).toBe(true);
    expect(events).toEqual([
      {
        provider: "discord",
        deliveryId: "INTERACTION_CREATE:interaction-1",
        eventType: "INTERACTION_CREATE",
        coalesceKey: "discord:channel:channel-owned",
        actorExternalId: "captain-1",
        payload: {
          ...incoming,
          d: { ...incoming.d, token: "[REDACTED]" },
        },
        requestMetadata: {
          source: "gateway",
          sequence: 42,
          guild_id: "guild-1",
          channel_id: "channel-owned",
          managed_category_id: "category-agentos",
          interaction_delivery: "follow-up",
          redacted_fields: "d.token",
        },
      },
    ]);
    expect(acknowledgements).toEqual([
      {
        interactionId: "interaction-1",
        token: "interaction-secret",
        responseType: 6,
      },
    ]);
  });

  test("preserves steer and stop intent for generic controls", async () => {
    const { acknowledgements, events, router } = setup();
    await router.handle(
      dispatch("READY", { user: { id: "firstmate-bot" } }, 1),
    );

    expect(
      await router.handle(
        dispatch("INTERACTION_CREATE", {
          id: "interaction-steer",
          token: "steer-secret",
          type: 5,
          guild_id: "guild-1",
          channel_id: "channel-owned",
          member: { user: { id: "captain-1" } },
          data: { custom_id: "agentos:steer:active-work" },
        }),
      ),
    ).toBe(true);
    expect(
      await router.handle(
        dispatch("INTERACTION_CREATE", {
          id: "interaction-stop",
          token: "stop-secret",
          type: 3,
          guild_id: "guild-1",
          channel_id: "channel-owned",
          member: { user: { id: "captain-1" } },
          data: {
            component_type: 2,
            custom_id: "agentos:stop:active-work",
          },
        }),
      ),
    ).toBe(true);

    expect(
      events.map((event) => event.requestMetadata.interaction_delivery),
    ).toEqual(["steer", "stop"]);
    expect(acknowledgements).toEqual([
      {
        interactionId: "interaction-steer",
        token: "steer-secret",
        responseType: 5,
      },
      {
        interactionId: "interaction-stop",
        token: "stop-secret",
        responseType: 6,
      },
    ]);
  });
});
