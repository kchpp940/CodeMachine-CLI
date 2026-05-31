/**
 * Source resolution service for CodeMachine imports.
 *
 * Responsible for turning a user-supplied source string
 * (short name, owner/repo, full URL, or local path) into a
 * structured `ResolvedSource` that downstream services can act on.
 */

import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { ResolvedSource } from '../types.js';

const GITHUB_BASE = 'https://github.com';
const GITHUB_API_BASE = 'https://api.github.com';
const LOCAL_MANIFEST_FILENAME = '.codemachine.json';
const STANDARD_MANIFEST_FILENAME = 'codemachine.json';

function hasManifestFile(dirPath: string): boolean {
  return (
    existsSync(resolve(dirPath, LOCAL_MANIFEST_FILENAME)) ||
    existsSync(resolve(dirPath, STANDARD_MANIFEST_FILENAME))
  );
}

function resolveLocalPath(path: string): ResolvedSource | null {
  if (isAbsolute(path)) {
    if (existsSync(path) && hasManifestFile(path)) {
      return { type: 'local-path', url: path, repoName: basename(path) };
    }
    return null;
  }

  if (path.startsWith('./') || path.startsWith('../') || path.startsWith('~')) {
    const absolutePath = path.startsWith('~')
      ? path.replace('~', process.env.HOME || '')
      : resolve(path);

    if (existsSync(absolutePath) && hasManifestFile(absolutePath)) {
      return { type: 'local-path', url: absolutePath, repoName: basename(absolutePath) };
    }
    return null;
  }

  return null;
}

function resolveFullUrl(url: string): ResolvedSource {
  const parsed = new URL(url);
  const pathParts = parsed.pathname.split('/').filter(Boolean);

  let repoName = pathParts[pathParts.length - 1] || 'unknown';
  if (repoName.endsWith('.git')) {
    repoName = repoName.slice(0, -4);
  }

  const isGitHub =
    parsed.hostname === 'github.com' || parsed.hostname === 'www.github.com';

  return {
    type: isGitHub ? 'github-repo' : 'git-url',
    url: url.endsWith('.git') ? url : `${url}.git`,
    repoName,
    owner: pathParts.length >= 2 ? pathParts[0] : undefined,
  };
}

function resolveGitUrl(url: string): ResolvedSource {
  const match = url.match(/^git@([^:]+):(.+)$/);
  if (!match) {
    throw new Error(`Invalid git URL format: ${url}`);
  }

  const [, , path] = match;
  const pathParts = path.split('/').filter(Boolean);

  let repoName = pathParts[pathParts.length - 1] || 'unknown';
  if (repoName.endsWith('.git')) {
    repoName = repoName.slice(0, -4);
  }

  return {
    type: 'git-url',
    url,
    repoName,
    owner: pathParts.length >= 2 ? pathParts[0] : undefined,
  };
}

function resolveOwnerRepo(owner: string, repo: string): ResolvedSource {
  return {
    type: 'github-repo',
    url: `${GITHUB_BASE}/${owner}/${repo}.git`,
    repoName: repo,
    owner,
  };
}

async function resolveShortName(name: string): Promise<ResolvedSource> {
  const searchUrl = `${GITHUB_API_BASE}/search/repositories?q=${encodeURIComponent(name)}+in:name`;

  try {
    const response = await fetch(searchUrl, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'CodeMachine-CLI',
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      items: Array<{ full_name: string; name: string; clone_url: string }>;
    };

    const exactMatch = data.items.find(
      (repo) => repo.name.toLowerCase() === name.toLowerCase(),
    );

    if (exactMatch) {
      return {
        type: 'github-search',
        url: exactMatch.clone_url,
        repoName: exactMatch.name,
        owner: exactMatch.full_name.split('/')[0],
      };
    }

    throw new Error(
      `Could not find repository "${name}" on GitHub. Try using the full format: owner/${name}`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('Could not find')) {
      throw error;
    }
    throw new Error(
      `Failed to search GitHub for "${name}". Try using the full format: owner/${name}`,
    );
  }
}

export async function resolveSource(input: string): Promise<ResolvedSource> {
  const trimmed = input.trim();

  const localResult = resolveLocalPath(trimmed);
  if (localResult) return localResult;

  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    return resolveFullUrl(trimmed);
  }

  if (trimmed.startsWith('git@')) {
    return resolveGitUrl(trimmed);
  }

  if (trimmed.includes('.') && trimmed.includes('/')) {
    const absolutePath = resolve(trimmed);
    if (existsSync(absolutePath)) {
      const localCheck = resolveLocalPath(absolutePath);
      if (localCheck) return localCheck;
    }
    return resolveFullUrl(`https://${trimmed}`);
  }

  if (trimmed.includes('/') && !trimmed.includes('.')) {
    const absolutePath = resolve(trimmed);
    if (existsSync(absolutePath)) {
      const localCheck = resolveLocalPath(absolutePath);
      if (localCheck) return localCheck;
    }
    const [owner, repo] = trimmed.split('/');
    return resolveOwnerRepo(owner, repo);
  }

  return resolveShortName(trimmed);
}

export function extractRepoName(source: string): string {
  const trimmed = source.trim();

  if (!trimmed.includes('/') && !trimmed.includes('.')) {
    return trimmed;
  }

  if (trimmed.includes('/') && !trimmed.includes('.')) {
    return trimmed.split('/').pop() || trimmed;
  }

  try {
    const url = trimmed.startsWith('http')
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
    const parts = url.pathname.split('/').filter(Boolean);
    let name = parts.pop() || trimmed;
    if (name.endsWith('.git')) {
      name = name.slice(0, -4);
    }
    return name;
  } catch {
    return trimmed;
  }
}
