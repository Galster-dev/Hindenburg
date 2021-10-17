require("./modulePatch");
const path = require("path");
const fs = require("fs");
const net = require("net");
const chalk = require("chalk");
const https = require("https");
const compareVersions = require("compare-versions");
const chokidar = require("chokidar");

const { createSpinner, stopSpinner, createDefaultConfig, runCommandInDir } = require("./util");
const { Worker } = require("../src");
const { recursiveAssign } = require("../src/util/recursiveAssign");

const configFile = process.env.HINDENBURG_CONFIG || path.join(process.cwd(), "./config.json");
async function resolveConfig() {
    try {
        return JSON.parse(await fs.promises.readFile(configFile, "utf8"));
    } catch (e) {
        if (e.code === "ENOENT"){
            const configSpinner = createSpinner("Creating config.json..");
            try {
                const defaultConfig = createDefaultConfig();
                await fs.promises.writeFile(
                    configFile,
                    JSON.stringify(defaultConfig, undefined, 4),
                    "utf8"
                );
                stopSpinner(configSpinner, true);
                return true;
            } catch (e) {
                stopSpinner(configSpinner, false);
                return false;
            }
        }
        return false;
    }
}

function parseCommmandLine(config) {
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith("--")) {
            const configPath = argv[i].substr(2);
            const cmdValue = argv[i + 1];

            if (!cmdValue) {
                continue;
            }

            const configValue = JSON.parse(cmdValue);

            const pathParts = [];
            let acc = "";
            for (let i = 0; i < configPath.length; i++) {
                if (configPath[i] === ".") {
                    if (acc) {
                        pathParts.push(acc);
                        acc = "";
                    }
                } else if (configPath[i] === "[") {
                    pathParts.push(acc);
                    acc = "";
                    let computed = "";
                    for (let j = i + 1; j < configPath.length; j++) {
                        if (configPath[j] === "]") {
                            i = j;
                            break;
                        }

                        computed += configPath[j];
                    }
                    acc += computed;
                } else {
                    acc += configPath[i];
                }
            }
            if (acc) {
                pathParts.push(acc);
                acc = "";
            }

            let curObj = config;
            for (let i = 0; i < pathParts.length - 1; i++) {
                if (typeof curObj[pathParts[i]] !== "object") {
                    curObj[pathParts[i]] = {};
                }

                curObj = curObj[pathParts[i]];
            }

            curObj[pathParts[pathParts.length - 1]] = configValue;
        }
    }
}

function makeHttpRequest(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, res => {
            if (res.statusCode !== 200) {
                return reject("Got non-200 status code for " + url + ": " + res.statusCode);
            }
            const buffers = [];
            res.on("data", data => {
                buffers.push(data);
            });
            res.on("end", () => {
                const fullData = Buffer.concat(buffers);
                resolve(fullData);
            });
            res.on("error", e => {
                reject(e);
            });
        });
        req.end();
    });
}

async function getLatestVersion() {
    const fullData = await makeHttpRequest("https://raw.githubusercontent.com/SkeldJS/Hindenburg/master/package.json");
    try {
        const json = JSON.parse(fullData.toString("utf8"));
        if (json.version) {
            return json.version;
        }
    } catch (e) {
        throw e;
    }
}

let cachedIp;
async function getOwnIpAddress() {
    if (cachedIp)
        return cachedIp;

    const ipSpinner = createSpinner("Fetching ip address..");
    try {
        cachedIp = await makeHttpRequest("https://api.ipify.org");
        cachedIp = cachedIp.toString().trim();
        stopSpinner(ipSpinner, true);
    } catch (e) {
        stopSpinner(ipSpinner, false);
        console.log("Failed to get ip address, please enter it manually in the config.socket.ip option.");
    }

    return cachedIp;
}

async function fixConfig(config) {
    if (config && config.socket && config.socket.ip === "auto") {
        config.socket.ip = await getOwnIpAddress();
    }
}

async function getInternalIp() {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(80, "api.ipify.org");
        socket.on("connect", function() {
            resolve(socket.address().address);
            socket.end();
        });
        socket.on("error", function(e) {
            reject(e);
            socket.end();
        });
    });
}

(async () => {
    const internalIp = await getInternalIp();

    const workerConfig = createDefaultConfig();
    const resolvedConfig = await resolveConfig();
    recursiveAssign(workerConfig, resolvedConfig || {});
    await fixConfig(workerConfig);
    parseCommmandLine(workerConfig);

    if (workerConfig.autoUpdate) {
        const versionSpinner = createSpinner("Checking for updates..");
        try {
            const latestVersion = await getLatestVersion();
            const compare = compareVersions(latestVersion, process.env.npm_package_version);
            stopSpinner(versionSpinner, true);

            if (compare === 1) {
                if (workerConfig.autoUpdate) {
                    console.log(chalk.yellow("New version of Hindenburg available: " + latestVersion));

                    const gitPullSpinner = createSpinner("Pulling from remote repository..");
                    try {
                        await runCommandInDir(process.cwd(), "git pull");
                        stopSpinner(gitPullSpinner, true);

                        const installSpinner = createSpinner("Installing dependencies..");
                        try {
                            await runCommandInDir(process.cwd(), "yarn");
                            stopSpinner(installSpinner, true);

                            const yarnBuildSpinner = createSpinner("Building..");

                            try {
                                await runCommandInDir(process.cwd(), "yarn build");
                                stopSpinner(yarnBuildSpinner, true);

                                delete require.cache[require.resolve("../src")];

                                Worker = require("../src").Worker;
                            } catch (e) {
                                stopSpinner(gitPullSpinner, false);
                                console.error("Failed to build latest changes, use 'yarn build' to update manually.");
                            }
                        } catch (e) {
                            stopSpinner(installSpinner, false);
                            console.error("Failed to install dependencies, use 'yarn' and 'yarn build' to update manually.");
                        }
                    } catch (e) {
                        stopSpinner(gitPullSpinner, false);
                        console.error("Failed to pull latest changes, use 'git pull', 'yarn' and 'yarn build' to update manually.");
                    }
                } else {
                    console.log(chalk.yellow("New version of Hindenburg available: " + latestVersion + ", use 'git pull && yarn build' to update"));
                }
            }
        } catch (e) {
            stopSpinner(versionSpinner, false);
            console.error("Failed to check for updates, nevermind");
        }
    }

    const pluginDirectory = process.env.HINDENBURG_PLUGINS || path.resolve(process.cwd(), "./plugins");
    const worker = new Worker("TEST", 0, workerConfig, pluginDirectory);

    if (!resolvedConfig) {
        worker.logger.warn("Cannot open config file; using default config");
    }

    const port = worker.config.socket.port;
    await worker.listen(port);

    worker.logger.info("Listening on:");

    if (!worker.config.logging.hideSensitiveInfo) {
        worker.logger.info(chalk.grey`External: ${chalk.white(worker.config.socket.ip)}:${port}`);
    }
    worker.logger.info(chalk.grey`Internal: ${chalk.white(internalIp)}:${port}`);
    worker.logger.info(chalk.grey`   Local: ${chalk.white("127.0.0.1")}:${port}`);

    if (worker.config.plugins.loadDirectory) {
        await worker.pluginLoader.importFromDirectory();
        await worker.pluginLoader.loadAllWorkerPlugins();
    }

    const configWatch = chokidar.watch(configFile, {
        persistent: false,
        encoding: "utf8"
    });

    configWatch.on("change", async eventType => {
        worker.logger.info("Config file updated, reloading..");
        try {
            const workerConfig = createDefaultConfig();
            const updatedConfig = JSON.parse(await fs.promises.readFile(configFile, "utf8"));
            recursiveAssign(workerConfig, updatedConfig || {});
            await fixConfig(workerConfig);
            parseCommmandLine(workerConfig);

            worker.updateConfig(workerConfig);
        } catch (e) {
            if (e.code) {
                worker.logger.warn("Cannot open config file (" + e.code + "); not reloading config.");
            }
        }
    });
})();
