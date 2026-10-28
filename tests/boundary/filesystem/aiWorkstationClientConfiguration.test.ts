import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

const command = npxRegistrationCommand(process.platform);

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const workstation = (home: string, platform: NodeJS.Platform = "linux") =>
  supportedClients(home, platform, {}).find(
    ({ name }) => name === "ai_workstation",
  );

/** A Workstation folder as its installer leaves it, recorded or default. */
const workstationHome = async (recorded: boolean) => {
  const home = await createTestTempDirectory("rea-workstation-");
  const root = recorded
    ? join(home, "AI", "Workstation")
    : join(home, "RG Studios", "Workstation");
  await mkdir(join(root, "tools"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, "tools", "mcpo-config.json"), '{"mcpServers":{}}');
  await mkdir(join(home, "RG Studios"), { recursive: true });
  // PowerShell's WriteAllText leaves no BOM, but Set-Content does; accept both.
  if (recorded)
    await writeFile(
      join(home, "RG Studios", "workstation-folder.txt"),
      `﻿${root}\r\n`,
    );
  return { home, root };
};

describe("Custom AI Workstation configuration paths", () => {
  it("uses the installer's default folder when none is recorded", async () => {
    const { home, root } = await workstationHome(false);
    expect(workstation(home)).toMatchObject({
      configPath: join(root, "data", "mcpo-extra.json"),
      markerPath: join(root, "tools", "mcpo-config.json"),
      format: "json",
      registrationEnvironment: { REA_MCP_TOOL_SURFACE: "router" },
    });
  });

  it("follows the folder the installer recorded", async () => {
    const { home, root } = await workstationHome(true);
    expect(workstation(home)?.configPath).toBe(
      join(root, "data", "mcpo-extra.json"),
    );
  });

  it("reports a recorded folder that is not absolute instead of guessing", async () => {
    const { home } = await workstationHome(false);
    await writeFile(
      join(home, "RG Studios", "workstation-folder.txt"),
      "Workstation",
    );
    expect(workstation(home)?.configPathError).toMatch(/not an absolute/u);
  });
});

describe("Custom AI Workstation registration", () => {
  it("adds rea with the router surface beside the tool store's servers", async () => {
    const { home } = await workstationHome(true);
    const client = workstation(home, process.platform);
    if (client === undefined) throw new Error("missing Workstation client");
    const github = {
      command: "npx",
      args: ["-y", "github-mcp"],
      env: { GITHUB_TOKEN: "kept" },
    };
    await writeFile(
      client.configPath,
      JSON.stringify({ mcpServers: { github } }, null, 2),
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.github).toEqual(github);
    expect(parsed.mcpServers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
      env: { REA_MCP_TOOL_SURFACE: "router" },
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client: name }) => name === "ai_workstation"),
    ).toMatchObject({ state: "aligned", command });

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const removed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(removed.mcpServers).toEqual({ github });
  });

  it("keeps a surface the person chose", async () => {
    const { home } = await workstationHome(false);
    const client = workstation(home, process.platform);
    if (client === undefined) throw new Error("missing Workstation client");
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: command[0],
            args: command.slice(1),
            env: { REA_MCP_TOOL_SURFACE: "full" },
          },
        },
      }),
    );
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
  });
});
