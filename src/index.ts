/**
 * CHANNEL_CONFIG defines the default configuration options for Supabase realtime channels.
 *
 * - broadcast: Ensures that broadcast events are acknowledged (ack: true)
 *   and that the sender (self: true) receives its own broadcast if needed.
 *
 * - presence: Object for presence tracking. Customize this object if additional presence configuration is needed.
 */
const CHANNEL_CONFIG = {
    broadcast: {
        ack: true,
        self: true,
    },
    presence: {},
}

import {
    RealtimeChannel,
    SupabaseClient,
    type RealtimeChannelSendResponse,
} from '@supabase/supabase-js'
import { ChannelError } from './errors'

export type ChannelEvent =
    | 'presence'
    | 'session_type'
    | 'recording'
    | 'editor_event'
    | 'video_processing'

export type ChannelMessageType = 'broadcast' | 'presence' | 'postgres_changes'

export interface ChannelMessage {
    type: ChannelMessageType
    event: ChannelEvent
    payload: Record<string, unknown>
}

export interface PresenceState {
    online_at: string
    client_type: 'web' | 'mobile'
    session_code: string
}

type EventHandler = (message: ChannelMessage) => void

/**
 * ChannelService is responsible for managing a realtime channel.
 * It handles channel initialization, subscription, presence syncing,
 * event dispatching, and cleanup.
 */
export class ChannelService {
    private channel: RealtimeChannel | null = null
    private eventHandlers: Map<ChannelEvent, EventHandler[]> = new Map()

    /**
     * @param supabase - Instance of the Supabase client.
     * @param pairingCode - The unique code used to pair sessions.
     * @param channelPrefix - The prefix used for the channel topic (default 'session').
     */
    constructor(
        private supabase: SupabaseClient,
        private pairingCode: string,
        private channelPrefix: string = 'session',
    ) {}

    /**
     * Gets the current presence state of the channel.
     */
    getPresenceState(): Record<string, PresenceState[]> {
        if (!this.channel) return {}

        const rawState = this.channel.presenceState()
        return Object.entries(rawState).reduce(
            (acc, [key, presences]) => {
                const validPresences = (presences as unknown[]).filter(
                    (p): p is Record<string, unknown> =>
                        p != null &&
                        typeof p === 'object' &&
                        'online_at' in p &&
                        'client_type' in p &&
                        'session_code' in p &&
                        typeof p.online_at === 'string' &&
                        (p.client_type === 'web' ||
                            p.client_type === 'mobile') &&
                        typeof p.session_code === 'string',
                )

                if (validPresences.length > 0) {
                    acc[key] = validPresences.map(p => ({
                        online_at: p.online_at as string,
                        client_type: p.client_type as 'web' | 'mobile',
                        session_code: p.session_code as string,
                    }))
                }
                return acc
            },
            {} as Record<string, PresenceState[]>,
        )
    }

    /**
     * Initializes the channel by subscribing and syncing presence.
     */
    async init(): Promise<void> {
        const topic = `${this.channelPrefix}:${this.pairingCode}`
        this.channel = this.supabase.channel(topic, { config: CHANNEL_CONFIG })

        // Set up presence event listeners
        this.channel.on('presence', { event: 'sync' }, () => {
            this.notifyPresenceChange()
        })

        this.channel.on('presence', { event: 'join' }, () => {
            this.notifyPresenceChange()
        })

        this.channel.on('presence', { event: 'leave' }, () => {
            this.notifyPresenceChange()
        })

        // Set up a generic broadcast event listener.
        this.channel.on('system', { event: '*' }, (message: ChannelMessage) => {
            console.log(`Received event [${message.event}] on channel ${topic}`)
            this.dispatch(message)
        })

        // Subscribe to the channel and wait for presence to sync.
        await this.subscribeAndSyncPresence()
    }

    /**
     * Notifies all presence event handlers of the current presence state.
     */
    private notifyPresenceChange(): void {
        const state = this.getPresenceState()
        this.dispatch({
            type: 'presence',
            event: 'presence',
            payload: { state },
        })
    }

    /**
     * Subscribes to the channel and tracks presence.
     * Waits until the presence-sync event is received before resolving.
     */
    private subscribeAndSyncPresence(): Promise<void> {
        return new Promise((resolve, reject) => {
            let presenceSynced = false

            // Listen for presence sync events.
            this.channel?.on('presence', { event: 'sync' }, () => {
                console.log(
                    `Presence sync event received for pairing code ${this.pairingCode}`,
                )
                presenceSynced = true
            })

            // Subscribe to channel and process subscription status.
            this.channel?.subscribe((status: string) => {
                console.log(`Channel subscription status: ${status}`)
                if (status === 'SUBSCRIBED') {
                    // Track this client as online.
                    this.channel?.track({
                        online_at: new Date().toISOString(),
                        client_type: 'web',
                        session_code: this.pairingCode,
                    })

                    // Check regularly until presence is confirmed.
                    const syncIntervalId = setInterval(() => {
                        if (presenceSynced) {
                            clearInterval(syncIntervalId)
                            resolve()
                        }
                    }, 100)
                } else if (['CHANNEL_ERROR', 'TIMED_OUT'].includes(status)) {
                    reject(
                        new Error(
                            `Channel subscription failed with status: ${status}`,
                        ),
                    )
                }
            })
        })
    }

    /**
     * Registers an event handler for a specific channel event.
     *
     * @param event - The channel event to listen for.
     * @param handler - The handler function to invoke when the event is received.
     */
    on(event: ChannelEvent, handler: EventHandler): void {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, [])
        }
        this.eventHandlers.get(event)?.push(handler)
    }

    /**
     * Unregisters an event handler for a specific channel event.
     *
     * @param event - The event from which to remove the handler.
     * @param handler - The handler function to remove.
     */
    off(event: ChannelEvent, handler: EventHandler): void {
        const handlers = this.eventHandlers.get(event) || []
        this.eventHandlers.set(
            event,
            handlers.filter(existingHandler => existingHandler !== handler),
        )
    }

    /**
     * Dispatches a received channel message to all registered handlers for its event type.
     *
     * @param message - The message received from the channel.
     */
    private dispatch(message: ChannelMessage): void {
        const handlers = this.eventHandlers.get(message.event) || []
        for (const handler of handlers) {
            try {
                handler(message)
            } catch (error) {
                console.error(`Error handling event [${message.event}]:`, error)
            }
        }
    }

    /**
     * Sends a message through the channel.
     *
     * @param message - The ChannelMessage to send.
     * @throws Will throw an error if the channel has not been initialized.
     */
    send(message: ChannelMessage): Promise<RealtimeChannelSendResponse> {
        if (!this.channel) {
            throw new ChannelError('Channel not initialized')
        }
        return this.channel.send(message)
    }

    /**
     * Cleans up the channel by unsubscribing and clearing registered event handlers.
     */
    cleanup(): void {
        if (this.channel) {
            this.channel.unsubscribe()
            this.channel = null
        }
        this.eventHandlers.clear()
    }
}
