import "reflect-metadata";

import { Deserializable, RpcMessage } from "@skeldjs/protocol";
import { Networkable, NetworkableEvents, PlayerData } from "@skeldjs/core";

import path from "path";
import util from "util";
import fs from "fs/promises";

import winston from "winston";
import vorpal from "vorpal";
import resolvePkg from "resolve-pkg";
import chalk from "chalk";

import { Worker, WorkerEvents } from "../Worker";
import { Room } from "../Room";

import {
    getPluginChatCommands,
    getPluginCliCommands,
    getPluginEventListeners,
    getPluginMessageHandlers,
    getPluginReactorRpcHandlers,
    getPluginRegisteredMessages,
    isHindenburgPlugin,
    BaseReactorRpcMessage,
    MessageHandlerOptions,
    shouldPreventLoading
} from "../api";

import { VorpalConsole } from "../util/VorpalConsoleTransport";
import { recursiveClone } from "../util/recursiveClone";
import { recursiveAssign } from "../util/recursiveAssign";
import { RoomEvents } from "../BaseRoom";
import { ReactorRpcMessage } from "../packets";

export const hindenburgPluginDirectory = Symbol("hindenburg:plugindirectory");

export interface PluginMetadata {
    id: string;
    version: string;
    order: "first"|"none"|"last"|number;
    defaultConfig: any;
}

export class Plugin {
    static meta: PluginMetadata;
    meta!: PluginMetadata;

    logger!: winston.Logger;

    baseDirectory!: string;

    loadedChatCommands: string[];
    loadedCliCommands: vorpal.Command[];
    loadedEventListeners: {
        eventName: string;
        handler: (...args: any) => any;
    }[];
    loadedMessageHandlers: {
        messageCtr: Deserializable;
        options: MessageHandlerOptions;
        handler: (...args: any) => any;
    }[];
    loadedReactorRpcHandlers: {
        reactorRpc: typeof BaseReactorRpcMessage,
        handler: (component: Networkable, rpc: BaseReactorRpcMessage) => any
    }[];
    loadedRegisteredMessages: Deserializable[];

    constructor(public readonly config: any) {
        this.loadedChatCommands = [];
        this.loadedCliCommands = [];
        this.loadedEventListeners = [];
        this.loadedMessageHandlers = [];
        this.loadedReactorRpcHandlers = [];
        this.loadedRegisteredMessages = [];
    }

    [Symbol.for("nodejs.util.inspect.custom")]() {
        return chalk.green(this.meta.id) + chalk.grey("@v" + this.meta.version);
    }

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onPluginLoad(): any {}
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onPluginUnload(): any {}

    async sendReactorRpc(component: Networkable<unknown, NetworkableEvents, Room>, rpc: BaseReactorRpcMessage, target?: PlayerData): Promise<void> {
        if (!rpc.modId)
            throw new TypeError("Bad reactor rpc: expected modId property.");

        if (typeof component.room.worker.config.reactor !== "boolean") {
            const modConfig = component.room.worker.config.reactor.mods[rpc.modId];
            if (typeof modConfig === "object") {
                if (modConfig.doNetworking === false) { // doNetworking can be undefined and is defaulted to true
                    return;
                }
            }
        }

        for (const [ , player ] of target ? [ [ target, target ]] : component.room.players) { // cheap way to do the same thing for whether a target is specified or not
            const playerConnection = component.room.connections.get(player.clientId);

            if (playerConnection) {
                const targetMod = playerConnection.mods.get(rpc.modId);

                if (!targetMod)
                    continue;

                await player.room.broadcast([
                    new RpcMessage(
                        component.netId,
                        new ReactorRpcMessage(
                            targetMod.netId,
                            rpc
                        )
                    )
                ], true, player);
            }
        }
    }
}

export class RoomPlugin extends Plugin {
    public readonly worker: Worker;

    constructor(
        public readonly room: Room,
        public readonly config: any
    ) {
        super(config);

        this.worker = room.worker;

        this.logger = winston.createLogger({
            levels: {
                error: 0,
                debug: 1,
                warn: 2,
                data: 3,
                info: 4,
                verbose: 5,
                silly: 6,
                custom: 7
            },
            transports: [
                new VorpalConsole(this.room.worker.vorpal, {
                    format: winston.format.combine(
                        winston.format.splat(),
                        winston.format.colorize(),
                        winston.format.printf(info => {
                            return `[${util.format(this.room)} ${this.meta.id}] ${info.level}: ${info.message}`;
                        }),
                    ),

                }),
                new winston.transports.File({
                    filename: "logs.txt",
                    format: winston.format.combine(
                        winston.format.splat(),
                        winston.format.simple()
                    )
                })
            ]
        });
    }
}

export class WorkerPlugin extends Plugin {
    constructor(
        public readonly worker: Worker,
        public readonly config: any
    ) {
        super(config);

        this.logger = winston.createLogger({
            levels: {
                error: 0,
                debug: 1,
                warn: 2,
                data: 3,
                info: 4,
                verbose: 5,
                silly: 6,
                custom: 7
            },
            transports: [
                new VorpalConsole(this.worker.vorpal, {
                    format: winston.format.combine(
                        winston.format.splat(),
                        winston.format.colorize(),
                        winston.format.printf(info => {
                            return `[${this.meta.id}] ${info.level}: ${info.message}`;
                        }),
                    ),

                }),
                new winston.transports.File({
                    filename: "logs.txt",
                    format: winston.format.combine(
                        winston.format.splat(),
                        winston.format.simple()
                    )
                })
            ]
        });
    }
}

export class PluginLoader {
    workerPlugins: Map<string, typeof WorkerPlugin>;
    roomPlugins: Map<string, typeof RoomPlugin>;

    constructor(
        public readonly worker: Worker,
        public readonly pluginDirectory: string
    ) {
        this.workerPlugins = new Map;
        this.roomPlugins = new Map;
    }

    isHindenburgPlugin(someObject: any) {
        return isHindenburgPlugin(someObject);
    }

    isWorkerPlugin(pluginCtr: typeof WorkerPlugin|typeof RoomPlugin): pluginCtr is typeof WorkerPlugin {
        let currentCtr: typeof WorkerPlugin|typeof RoomPlugin = pluginCtr;
        while (currentCtr !== null) {
            currentCtr = Object.getPrototypeOf(currentCtr);

            if (currentCtr === WorkerPlugin)
                return true;
        }
        return false;
    }


    isRoomPlugin(pluginCtr: typeof WorkerPlugin|typeof RoomPlugin): pluginCtr is typeof RoomPlugin {
        let currentCtr: typeof WorkerPlugin|typeof RoomPlugin = pluginCtr;
        while (currentCtr !== null) {
            currentCtr = Object.getPrototypeOf(currentCtr);

            if (currentCtr === RoomPlugin)
                return true;
        }
        return false;
    }

    async importFromId(id: string) {
        const resolvedPkg = resolvePkg(id, { cwd: this.pluginDirectory });

        const pluginPath = resolvedPkg
            || path.resolve(this.pluginDirectory, "./" + id);

        const pluginCtr = await this.importPlugin(pluginPath);

        if (!pluginCtr) {
            return false;
        }

        return true;
    }

    async importFromDirectory() {
        if (!path.isAbsolute(this.pluginDirectory)) {
            throw new Error("Expected an absolute path to a plugin directory");
        }

        const pluginPaths: string[] = [];

        try {
            const packageJson = await fs.readFile(path.resolve(this.pluginDirectory, "package.json"), "utf8");
            const json = JSON.parse(packageJson) as { dependencies: Record<string, string> };

            for (const dependencyName in json.dependencies) {
                if (dependencyName.startsWith("hbplugin-")) {
                    const resolvedPkg = resolvePkg(dependencyName, { cwd: this.pluginDirectory });
                    if (resolvedPkg) {
                        pluginPaths.push(resolvedPkg);
                    }
                }
            }
        } catch (e) {
            if ((e as any).code !== undefined) {
                if ((e as any).code === "ENOENT") {
                    this.worker.logger.warn("No package.json in plugin directory");
                    return;
                }

                this.worker.logger.warn("Could not open package.json: %s", (e as any).code);
            }
            throw e;
        }

        const filesInDir = await fs.readdir(this.pluginDirectory);
        for (const file of filesInDir) {
            if (file.startsWith("hbplugin-")) {
                pluginPaths.push(path.resolve(this.pluginDirectory, file));
            }
        }

        for (const pluginPath of pluginPaths) {
            try {
                const pluginCtr = await this.importPlugin(pluginPath);

                if (!pluginCtr) {
                    this.worker.logger.warn("Did not load plugin at '%s', as it was not a hindenburg plugin",
                        pluginPath);
                    continue;
                }
            } catch (e) {
                this.worker.logger.warn("Could not import plugin '%s': %s", path.basename(pluginPath), e);
                throw e;
            }
        }
    }

    isEnabled(pluginId: typeof WorkerPlugin): boolean;
    isEnabled(pluginId: typeof RoomPlugin, room: Room): boolean;
    isEnabled(pluginClass: typeof WorkerPlugin|typeof RoomPlugin, room?: Room) {
        if (shouldPreventLoading(pluginClass))
            return;

        if (this.worker.config.plugins[pluginClass.meta.id] === false) {
            return false;
        }

        if (room && !room.config.plugins[pluginClass.meta.id] === false) {
            return false;
        }

        return true;
    }

    async loadAllWorkerPlugins() { // todo: plugin load ordering
        for (const [ , importedPlugin ] of this.workerPlugins) {
            if (this.isEnabled(importedPlugin)) {
                await this.loadPlugin(importedPlugin.meta.id);
            }
        }
    }

    async loadAllRoomPlugins(room: Room) {
        for (const [ , importedPlugin ] of this.roomPlugins) {
            if (this.isEnabled(importedPlugin, room)) {
                await this.loadPlugin(importedPlugin.meta.id, room);
            }
        }
        this.applyChatCommands(room);
        this.applyReactorRpcHandlers(room);
    }

    async importPlugin(pluginPath: string): Promise<typeof WorkerPlugin|typeof RoomPlugin|false> {
        if (!path.isAbsolute(pluginPath)) {
            throw new Error("Expected an absolute path to a plugin but got a relative one.");
        }

        try {
            delete require.cache[require.resolve(pluginPath)];
        } catch (e) { // require.resolve will error if the module is not found
            return false;
        }
        const { default: pluginCtr } = await import(pluginPath) as { default: typeof WorkerPlugin|typeof RoomPlugin };

        if (!this.isHindenburgPlugin(pluginCtr))
            return false;

        const isWorkerPlugin = this.isWorkerPlugin(pluginCtr);
        const isRoomPlugin = this.isRoomPlugin(pluginCtr);

        if (!isWorkerPlugin && !isRoomPlugin)
            return false;

        if (isWorkerPlugin) {
            this.workerPlugins.set(pluginCtr.meta.id, pluginCtr as unknown as typeof WorkerPlugin);
        } else if (isRoomPlugin) {
            this.roomPlugins.set(pluginCtr.meta.id, pluginCtr as unknown as typeof RoomPlugin);
        }

        Reflect.defineMetadata(hindenburgPluginDirectory, pluginPath, pluginCtr);

        return pluginCtr;
    }

    private applyChatCommands(room: Room) {
        room.chatCommandHandler.registeredCommands.clear();
        room.chatCommandHandler.registerHelpCommand();
        for (const [ , loadedPlugin ] of this.worker.loadedPlugins) {
            const pluginChatCommands = getPluginChatCommands(loadedPlugin);
            for (const chatCommand of pluginChatCommands) {
                room.chatCommandHandler.registerCommand(chatCommand.usage, chatCommand.description, chatCommand.handler.bind(loadedPlugin));
            }
        }

        for (const [ , loadedPlugin ] of room.loadedPlugins) {
            const pluginChatCommands = getPluginChatCommands(loadedPlugin);
            for (const chatCommand of pluginChatCommands) {
                room.chatCommandHandler.registerCommand(chatCommand.usage, chatCommand.description, chatCommand.handler.bind(loadedPlugin));
            }
        }
    }

    private getReactorRpcHandlers(room: Room, reactorRpc: typeof BaseReactorRpcMessage) {
        const cachedHandlers = room.reactorRpcHandlers.get(reactorRpc);
        const handlers = cachedHandlers || [];
        if (!cachedHandlers) {
            room.reactorRpcs.set(`${reactorRpc.modId}:${reactorRpc.messageTag}`, reactorRpc);
            room.reactorRpcHandlers.set(reactorRpc, handlers);
        }
        return handlers;
    }

    private applyReactorRpcHandlers(room: Room) {
        room.reactorRpcHandlers.clear();
        for (const [ , loadedPlugin ] of this.worker.loadedPlugins) {
            for (const reactorRpcHandlerInfo of loadedPlugin.loadedReactorRpcHandlers) {
                this.getReactorRpcHandlers(room, reactorRpcHandlerInfo.reactorRpc).push(reactorRpcHandlerInfo.handler.bind(loadedPlugin));
            }
        }

        for (const [ , loadedPlugin ] of room.loadedPlugins) {
            for (const reactorRpcHandlerInfo of loadedPlugin.loadedReactorRpcHandlers) {
                this.getReactorRpcHandlers(room, reactorRpcHandlerInfo.reactorRpc).push(reactorRpcHandlerInfo.handler.bind(loadedPlugin));
            }
        }
    }

    private applyRegisteredMessages() {
        const listeners = new Map([...this.worker.decoder.listeners]);
        this.worker.decoder.reset();
        this.worker.decoder.listeners = listeners;
        this.worker.registerMessages();

        for (const [ , loadedPlugin ] of this.worker.loadedPlugins) {
            for (let i = 0; i <  loadedPlugin.loadedRegisteredMessages.length; i++) {
                const messageClass = loadedPlugin.loadedRegisteredMessages[i];
                this.worker.decoder.register(messageClass);
            }
        }
    }

    private applyMessageHandlers() {
        this.worker.decoder.listeners.clear();
        this.worker.registerPacketHandlers();

        for (const [ , loadedPlugin ] of this.worker.loadedPlugins) {
            for (let i = 0; i < loadedPlugin.loadedMessageHandlers.length; i++) {
                const { messageCtr, handler, options } = loadedPlugin.loadedMessageHandlers[i];
                if (options.override) {
                    this.worker.decoder.listeners.delete(`${messageCtr.messageType}:${messageCtr.messageTag}`);
                }

                this.worker.decoder.on(messageCtr, (message, direction, ctx) => handler(message, ctx));
            }
        }
    }

    async loadPlugin(pluginCtr: string|typeof WorkerPlugin): Promise<WorkerPlugin>;
    async loadPlugin(pluginCtr: string|typeof RoomPlugin, room?: Room): Promise<RoomPlugin>;
    async loadPlugin(pluginCtr: string|typeof WorkerPlugin|typeof RoomPlugin, room?: Room): Promise<WorkerPlugin | RoomPlugin> {
        if (typeof pluginCtr === "string") {
            const _pluginCtr = room
                ? this.roomPlugins.get(pluginCtr)
                : this.workerPlugins.get(pluginCtr);

            if (!_pluginCtr) {
                throw new Error("Plugin with ID '" + pluginCtr + "' not imported.");
            }
            if (this.isRoomPlugin(_pluginCtr)) {
                return await this.loadPlugin(_pluginCtr, room);
            } else {
                return await this.loadPlugin(_pluginCtr);
            }
        }

        const defaultConfig = recursiveClone(pluginCtr.meta.defaultConfig);
        recursiveAssign(defaultConfig, this.worker.config.plugins[pluginCtr.meta.id] || {});

        const isWorkerPlugin = this.isWorkerPlugin(pluginCtr);
        const isRoomPlugin = this.isRoomPlugin(pluginCtr);

        if (isWorkerPlugin && room) {
            throw new Error("Attempted to load a worker plugin on a room or other non-worker object");
        } else if (isRoomPlugin && !room) {
            throw new Error("Attempted to load a room plugin on a worker or other non-room object.");
        }

        const initPlugin = isWorkerPlugin
            ? new (pluginCtr as unknown as typeof WorkerPlugin)(this.worker, defaultConfig)
            : new (pluginCtr as unknown as typeof RoomPlugin)(room!, defaultConfig);

        const reactorRpcHandlers = getPluginReactorRpcHandlers(initPlugin);

        for (const reactorRpcHandler of reactorRpcHandlers) {
            initPlugin.loadedReactorRpcHandlers.push(reactorRpcHandler);
        }

        if (isRoomPlugin && room) {
            room.loadedPlugins.set(pluginCtr.meta.id, initPlugin as RoomPlugin);
            this.applyChatCommands(room);
            this.applyReactorRpcHandlers(room);

            room.logger.info("Loaded plugin: %s", initPlugin);
        }

        if (isWorkerPlugin) {
            const cliCommands = getPluginCliCommands(initPlugin);
            const messageHandlers = getPluginMessageHandlers(initPlugin);
            const registeredMessages = getPluginRegisteredMessages(pluginCtr);

            for (const commandInfo of cliCommands) {
                const command = this.worker.vorpal.command(commandInfo.command.usage, commandInfo.command.description);

                if (commandInfo.command.options) {
                    for (let i = 0; i < commandInfo.command.options.length; i++) {
                        const option = commandInfo.command.options[i];
                        command.option(option.usage, option.description || "");
                    }
                }

                const fn = commandInfo.handler.bind(initPlugin);
                command.action(fn);

                initPlugin.loadedCliCommands.push(command);
            }

            for (const messageHandlerInfo of messageHandlers) {
                initPlugin.loadedMessageHandlers.push({
                    messageCtr: messageHandlerInfo.messageClass,
                    options: messageHandlerInfo.options,
                    handler: messageHandlerInfo.handler.bind(initPlugin)
                });
            }

            initPlugin.loadedRegisteredMessages = [...registeredMessages];

            this.worker.loadedPlugins.set(pluginCtr.meta.id, initPlugin as WorkerPlugin);

            this.applyMessageHandlers();
            this.applyRegisteredMessages();

            this.worker.logger.info("Loaded plugin globally: %s", initPlugin);
        }

        const eventListeners = getPluginEventListeners(initPlugin);

        for (const eventListenerInfo of eventListeners) {
            const fn = eventListenerInfo.handler.bind(initPlugin);
            if (room) {
                room.on(eventListenerInfo.eventName, fn);
            } else {
                this.worker.on(eventListenerInfo.eventName, fn);
            }
            initPlugin.loadedEventListeners.push({
                eventName: eventListenerInfo.eventName,
                handler: fn
            });
        }

        await initPlugin.onPluginLoad();

        return initPlugin;
    }

    unloadPlugin(pluginCtr: string|WorkerPlugin|typeof WorkerPlugin): void;
    unloadPlugin(pluginCtr: string|RoomPlugin|typeof RoomPlugin, room: Room): void;
    unloadPlugin(pluginCtr: string|RoomPlugin|typeof RoomPlugin|WorkerPlugin|typeof WorkerPlugin, room?: Room) {
        const pluginId = typeof pluginCtr === "string"
            ? pluginCtr
            : pluginCtr.meta.id;

        const loadedPlugin = room
            ? room.loadedPlugins.get(pluginId)
            : this.worker.loadedPlugins.get(pluginId);

        if (!loadedPlugin)
            throw new Error("Tried to unload a plugin that wasn't loaded");

        loadedPlugin.onPluginUnload();

        if (room) {
            room.loadedPlugins.delete(pluginId);
            this.applyChatCommands(room);
            room.logger.info("Unloaded plugin: %s", loadedPlugin);
        } else {
            this.worker.loadedPlugins.delete(pluginId);
            this.applyMessageHandlers();
            this.applyRegisteredMessages();
            this.worker.logger.info("Unloaded plugin globally: %s", loadedPlugin);
        }

        for (const loadedEventListener of loadedPlugin.loadedEventListeners) {
            if (room) {
                room.off(loadedEventListener.eventName as keyof RoomEvents, loadedEventListener.handler);
            } else {
                this.worker.off(loadedEventListener.eventName as keyof WorkerEvents, loadedEventListener.handler);
            }
        }
    }
}
