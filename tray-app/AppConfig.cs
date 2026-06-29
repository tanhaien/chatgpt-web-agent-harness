// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LocalCodingAgentTray;

public class AppConfig
{
    public string NodePath { get; set; } = "node";
    public string McpAppDir { get; set; } = "";
    public string ServerScript { get; set; } = "server.mjs";
    public string TunnelExe { get; set; } = "";
    public string TunnelProfileName { get; set; } = "local-coding-agent";
    public string TunnelProfileDir { get; set; } = "";
    public string Workspace { get; set; } = "";
    public string ExtraRoots { get; set; } = "";
    public string Mode { get; set; } = "safe";
    public int Port { get; set; } = 8787;
    public int DashboardPort { get; set; } = 8790;
    public string AuthToken { get; set; } = "";
    public bool OpenWebUi { get; set; } = true;

    /// <summary>DPAPI-encrypted (CurrentUser) tunnel key, base64. Never stored in plain text.</summary>
    public string EncryptedKey { get; set; } = "";

    [JsonIgnore]
    public static string ConfigDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "LocalCodingAgent");

    [JsonIgnore]
    public static string ConfigPath => Path.Combine(ConfigDir, "config.json");

    [JsonIgnore]
    public bool HasKey => !string.IsNullOrEmpty(EncryptedKey);

    [JsonIgnore]
    public string McpUrl => $"http://127.0.0.1:{Port}/mcp";

    [JsonIgnore]
    public string HealthUrl => $"http://127.0.0.1:{Port}/healthz";

    [JsonIgnore]
    public string DashboardUrl => $"http://127.0.0.1:{DashboardPort}/ui";

    public static AppConfig Load()
    {
        AppConfig cfg;
        try
        {
            if (File.Exists(ConfigPath))
                cfg = JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(ConfigPath)) ?? new AppConfig();
            else
                cfg = new AppConfig();
        }
        catch
        {
            cfg = new AppConfig();
        }
        cfg.FillDefaults();
        return cfg;
    }

    public void FillDefaults()
    {
        if (string.IsNullOrWhiteSpace(McpAppDir)) McpAppDir = Defaults.McpAppDir();
        if (string.IsNullOrWhiteSpace(TunnelExe)) TunnelExe = Defaults.TunnelExe();
        if (string.IsNullOrWhiteSpace(TunnelProfileDir)) TunnelProfileDir = Defaults.TunnelProfileDir();
        if (string.IsNullOrWhiteSpace(Workspace)) Workspace = Defaults.GuessWorkspace();
        if (Port <= 0) Port = 8787;
        if (DashboardPort <= 0) DashboardPort = 8790;
        // 8788 collides with the OpenAI tunnel-client's own health port; migrate off it.
        if (DashboardPort == 8788) DashboardPort = 8790;
        if (string.IsNullOrWhiteSpace(Mode)) Mode = "safe";
        if (string.IsNullOrWhiteSpace(ServerScript)) ServerScript = "server.mjs";
        if (string.IsNullOrWhiteSpace(NodePath)) NodePath = "node";
        if (string.IsNullOrWhiteSpace(TunnelProfileName)) TunnelProfileName = "local-coding-agent";
    }

    public void Save()
    {
        Directory.CreateDirectory(ConfigDir);
        var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(ConfigPath, json);
    }

    public void SetKey(string? plain)
    {
        if (string.IsNullOrEmpty(plain))
        {
            EncryptedKey = "";
            return;
        }
        var enc = ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), null, DataProtectionScope.CurrentUser);
        EncryptedKey = Convert.ToBase64String(enc);
    }

    public string? GetKey()
    {
        if (string.IsNullOrEmpty(EncryptedKey)) return null;
        try
        {
            var bytes = ProtectedData.Unprotect(Convert.FromBase64String(EncryptedKey), null, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(bytes);
        }
        catch
        {
            return null;
        }
    }
}
