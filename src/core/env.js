import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../config/defaults.js";

export function parseArgs(rawArgs) {
  const parsed = {};
  for (const arg of rawArgs) {
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const equalsIndex = body.indexOf("=");
    if (equalsIndex === -1) {
      parsed[body] = true;
    } else {
      parsed[body.slice(0, equalsIndex)] = body.slice(equalsIndex + 1);
    }
  }
  return parsed;
}

export function loadEnvFile(filePath) {
  try {
    return parseEnvContent(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

export function parseEnvContent(content) {
  return Object.fromEntries(
    String(content)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return index === -1 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

export function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

export function toInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toOptionalPositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function positiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} musi być liczbą całkowitą nie mniejszą niż 1.`);
  }
  return parsed;
}

export function nonNegativeInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} musi być liczbą całkowitą nie mniejszą niż 0.`);
  }
  return parsed;
}

export function resolveProjectPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
}

// Wiadomość odrzucenia, prompt oceny i wiadomość screeningu ładowały się trzema
// niemal identycznymi funkcjami. Kolejność źródeł jest wszędzie ta sama:
// plik wskazany flagą, wartość inline, wartość domyślna.
export function loadTextOption(args, env, {
  fileArg,
  fileEnv,
  inlineArg,
  inlineEnv,
  fallback = "",
  trim = "end",
}) {
  const messageFile = args[fileArg] || env[fileEnv] || "";
  if (messageFile) {
    return finish(fs.readFileSync(resolveProjectPath(messageFile), "utf8"));
  }

  const inline = args[inlineArg] || env[inlineEnv] || "";
  if (inline) {
    return finish(String(inline).replace(/\\n/g, "\n"));
  }

  return fallback;

  function finish(value) {
    if (trim === "both") return value.trim();
    if (trim === "end") return value.trimEnd();
    return value;
  }
}

export function loadLoginCredentials(args, env) {
  let username = args["login-username"] || env.LOGIN_USERNAME || "";
  let password = args["login-password"] || env.LOGIN_PASSWORD || "";
  const credentialsFile = args["login-credentials-file"] || env.LOGIN_CREDENTIALS_FILE || "";

  if (credentialsFile && (!username || !password)) {
    const content = fs.readFileSync(resolveProjectPath(credentialsFile), "utf8");

    // Plik może mieć postać KLUCZ=wartość albo dwie gołe linie: login i hasło.
    if (/^\s*[A-Z0-9_]+\s*=/im.test(content)) {
      const fileEnv = parseEnvContent(content);
      username ||= fileEnv.LOGIN_USERNAME || fileEnv.USERNAME || "";
      password ||= fileEnv.LOGIN_PASSWORD || fileEnv.PASSWORD || "";
    } else {
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      username ||= lines[0] || "";
      password ||= lines[1] || "";
    }
  }

  return { username, password };
}
