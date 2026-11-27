import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect, it, onTestFinished } from 'vitest';

import { DatabaseManager } from '../database/connection.js';
import { PlaylistRepository } from '../database/PlaylistRepository.js';
import { VideoRepository } from '../database/VideoRepository.js';
import { asPlaylistId } from '../types/index.js';

it('can move and browse the same two reports on each offline demo run', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'metube-demo-test-'));
  onTestFinished(() => fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3 }));
  const userDbPath = path.join(workspace, 'data', 'metube.db');
  const userDb = new DatabaseManager(userDbPath);
  try {
    new PlaylistRepository(userDb).createOrUpdate({
      playlistId: asPlaylistId('PLexisting'),
      title: 'Existing user playlist',
    });
  } finally {
    userDb.close();
  }
  const originalDb = fs.readFileSync(userDbPath);

  // Run the published npm script with the disposable library as its working directory.
  const project = fileURLToPath(new URL('../../', import.meta.url));
  fs.copyFileSync(path.join(project, 'package.json'), path.join(workspace, 'package.json'));
  for (const dir of ['node_modules', 'scripts']) {
    fs.symlinkSync(path.join(project, dir), path.join(workspace, dir), 'junction');
  }
  fs.copyFileSync(
    new URL('./fixtures/offline-network.cjs', import.meta.url),
    path.join(workspace, 'offline-network.cjs')
  );
  const run = (destination: string) => {
    const stdout = execSync('npm --offline --no-update-notifier run demo:report', {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: workspace,
        USERPROFILE: workspace,
        TMPDIR: workspace,
        TEMP: workspace,
        TMP: workspace,
        npm_config_cache: path.join(workspace, 'npm-cache'),
        npm_config_loglevel: 'silent',
        NODE_OPTIONS: '--require=./offline-network.cjs',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const playlist = fileURLToPath(stdout.trim());
    const reports = path.dirname(playlist);
    const demoRoot = path.dirname(reports);
    expect(path.dirname(demoRoot)).toBe(workspace);
    const db = new DatabaseManager(path.join(demoRoot, 'library.db'));
    try {
      const members = new VideoRepository(db).findByPlaylist(asPlaylistId('PLTideNotebook'));
      expect(members.map((video) => video.video_id)).toEqual(['tidalDemo01', 'tidalDemo02']);
    } finally {
      db.close();
    }

    const moved = path.join(workspace, destination);
    fs.renameSync(reports, moved);
    expect(fs.readdirSync(moved).filter((name) => name.endsWith('.html'))).toHaveLength(3);
    const movedPlaylist = pathToFileURL(path.join(moved, path.basename(playlist)));
    const html = fs.readFileSync(movedPlaylist, 'utf8');
    expect(html).toContain('<h1>The Tide Notebook</h1>');
    expect(html).toMatch(/>Reading the Tide Clock</);
    expect(html).toMatch(/>Surveying Glass Bay</);
    expect(html).toMatch(/>Tide gauges</);
    expect(html).toMatch(/>Coastal surveying</);
    const links = Array.from(
      html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>Read report<\/a>/g),
      ([, href]) => href
    );
    expect(links).toHaveLength(2);
    const pages = links.map((href) => {
      expect(href).not.toMatch(/^(?:[a-z]+:|[\\/])/i);
      const target = new URL(href, movedPlaylist);
      expect(path.dirname(fileURLToPath(target))).toBe(moved);
      return fs.readFileSync(target, 'utf8');
    });
    expect(pages[0]).toContain('<h1>Reading the Tide Clock</h1>');
    expect(pages[0]).toMatch(/>Tide gauges</);
    expect(pages[0]).toMatch(/>Coastal surveying</);
    expect(pages[0]).toMatch(/class="transcript">\[00:00\] The brass float marks the high tide\./);
    expect(pages[0]).not.toContain('Transcript unavailable');
    expect(pages[1]).toContain('<h1>Surveying Glass Bay</h1>');
    expect(pages[1]).toMatch(/>Transcript unavailable\.</);
    expect(pages[1]).not.toContain('The brass float marks the high tide.');
    expect(pages[1]).not.toMatch(/>(?:Tide gauges|Coastal surveying)</);
    for (const page of [html, ...pages]) {
      expect(page).not.toMatch(/<(?:img|link|script)\b[^>]*(?:src|href)="https?:/i);
    }
    expect(fs.readFileSync(userDbPath).equals(originalDb)).toBe(true);
    return { playlist: path.basename(playlist), links };
  };

  const firstLinks = run('first copy');
  expect(run('second copy')).toEqual(firstLinks);
}, 60_000);
