import { Deserializable, GetSerialized, MessageDirection } from "@skeldjs/protocol";
import { Client } from "../../Client";

export const MessageHandlers = "HindenburgPacketHandlers";
export const MessagesToRegister = "HindenburgRegisteredPackets";

export type PacketListener<T extends Deserializable> =
    ((message: GetSerialized<T>, direction: MessageDirection, client: Client) => any);

export interface OnMessageOptions {
    override: boolean;
}

export interface MessageHandlerDecl {
    propertyName: string;
    options: OnMessageOptions;
}

export function OnMessage<T extends Deserializable>(messageClass: T, options: Partial<OnMessageOptions> = {}) {
    return function (target: any, propertyName: string, descriptor: TypedPropertyDescriptor<PacketListener<T>>) {
        target[MessageHandlers] ||= new Map;
        target[MessagesToRegister] ||= new Set;

        let gotListeners: Set<MessageHandlerDecl> = target[MessageHandlers].get(messageClass);

        if (!gotListeners) {
            gotListeners = new Set;
            target[MessageHandlers].set(messageClass, gotListeners);
        }

        target[MessagesToRegister].add(messageClass);
        gotListeners.add({
            propertyName,
            options: {
                override: false,
                ...options
            }
        });
    }
}