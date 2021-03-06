import * as path from 'path';
import * as vscode from 'vscode';
import fetch from 'node-fetch';
import * as fs from "fs";
import * as zlib from "zlib";
import * as util from "util";
let tar = require("tar-fs");

import * as lc from 'vscode-languageclient/node';
import { pipeline } from 'stream';

let dbg = vscode.window.createOutputChannel("Numscript Extension Output");

function debug(...msg: [unknown, ...unknown[]]) {
	dbg.appendLine(msg.join(" "));
}

let client: lc.LanguageClient;

export async function fetchReleaseInfo(): Promise<GithubRelease> {
	const response = await fetch(
		"https://api.github.com/repos/numary/numscript-ls/releases/latest",
		{
			headers: { Accept: "application/vnd.github.v3+json" }
		}
	);
	if (!response.ok) {
		dbg.appendLine("Error fetching latest release info");
		throw new Error(
			`Got response ${response.status} when trying to fetch latest release`
		);
	}
	return await response.json();
}

export interface GithubRelease {
	name: string;
	id: number;
	published_at: string;
	assets: Array<GithubAsset>;
}

export interface GithubAsset {
	name: string;
	browser_download_url: vscode.Uri;
}

async function downloadServer(assets: Array<GithubAsset>, ctx: vscode.ExtensionContext): Promise<string> {
	const platforms_binaries = {
		"x64 windows": "Windows-64bit",
		"x64 linux": "Linux-64bit",
		"arm64 linux": "Linux-ARM64",
		"x64 darwin": "macOS-64bit",
		"arm64 darwin": "macOS-ARM64",
	};

	const platform = platforms_binaries[`${process.arch} ${process.platform}`];
	if (platform === undefined) {
		vscode.window.showErrorMessage(
			"Your platform does not have prebuilt language server binaries yet, " +
			"you'll have to clone numary/numscript-ls and build the server yourself, " +
			"then set the server path in the Numscript Extension's settings."
		);
		throw "no available binaries";
	}

	let asset = assets.find(a => a.name.toString().includes(platform));

	// debug(assets.map(a => a.name.toString()).join(" "));
	// vscode.window.showInformationMessage("Your platform binary's name is: " + asset.name);

	vscode.workspace.fs.createDirectory(ctx.globalStorageUri);
	const globalStorage = path.parse(ctx.globalStorageUri.fsPath);
	const res = await fetch(asset.browser_download_url);
	if (!res.ok) {
		throw new Error(`couldn't download file: got status code ${res.status}`);
	}

	const totalBytes = Number(res.headers.get('content-length'));
	debug(`Downloading server: ${totalBytes} bytes`);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			cancellable: false,
			title: "Downloading...",
		},
		async (progress, _cancellationToken) => {
			let readBytes = 0;
			res.body.on("data", (chunk: Buffer) => {
				readBytes += chunk.length;
				let percentage = readBytes / totalBytes;
				progress.report({
					message: `${percentage}`,
					increment: chunk.length / totalBytes
				});
				debug(`${readBytes} / ${totalBytes}`)
			});
		}
	)

	await util.promisify(pipeline)(res.body, zlib.createGunzip(), tar.extract(path.join(globalStorage.dir, globalStorage.base)));
	return path.join(globalStorage.dir, globalStorage.base, "numscript-ls");
}

async function resolveServerPath(ctx: vscode.ExtensionContext): Promise<string> {
	let serverPath: string = vscode.workspace.getConfiguration("numscript").get("server-path");
	if (serverPath !== null && serverPath !== "") {
		return serverPath
	}

	let releaseInfo = await fetchReleaseInfo();
	let currentServerTimestamp = ctx.globalState.get("serverTimestamp");
	debug(`stored timestamp: ${currentServerTimestamp}\nlatest timestamp: ${releaseInfo.published_at}`)
	if (currentServerTimestamp === releaseInfo.published_at) {
		let serverPath = path.join(ctx.globalStorageUri.fsPath, "numscript-ls")
		if (fs.existsSync(serverPath)) {
			return serverPath
		}
	}

	let selection = await vscode.window
		.showInformationMessage("Do you want to download the language server ?", "Yes", "No");
	if (selection != "Yes") {
		throw "user refused to download";
	}

	serverPath = await downloadServer(releaseInfo.assets, ctx);
	ctx.globalState.update("serverTimestamp", releaseInfo.published_at)
	return serverPath
}

export async function activate(ctx: vscode.ExtensionContext) {
	let serverPath = await resolveServerPath(ctx);

	let run: lc.Executable = {
		command: serverPath as string,
		options: {},
	};

	let serverOptions: lc.ServerOptions = { run: run, debug: run };

	let clientOptions: lc.LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'numscript' }],
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher('**/.num')
		}
	};

	client = new lc.LanguageClient(
		'languageServerNumscript',
		'Numscript Language Server',
		serverOptions,
		clientOptions
	);

	client.start();

	const restart = () => {
		dbg.appendLine("Requested server restart")
		client.stop().then(() => {
			dbg.appendLine("Restarting")
			client.start()
		})
	};

	ctx.subscriptions.push(vscode.commands.registerCommand("numscript.restart-server", restart));
	ctx.subscriptions.push(vscode.commands.registerCommand("numscript.download-server", () => {
		fetchReleaseInfo().then(releaseInfo => {
			downloadServer(releaseInfo.assets, ctx);
			restart();
		});
	}));
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
