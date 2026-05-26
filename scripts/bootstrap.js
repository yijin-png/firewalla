#!/usr/bin/env node
'use strict';

// ============================================================================
// Firewalla 软件版激活 bootstrap (Software-only activation bootstrap)
//
// 目标: 在通用硬件 (x86_64 / aarch64) 装上 Firewalla OS 之后, 用户在 box 上跑这个脚本, 通过 MSP 后端完成 license 绑定 + Guardian (MSP socket.io) 配置,
// 让 box 在真实 MSP web 设备列表里显示 online.
//
// 流程 (一人分饰两角 — bootstrap 同时担任 App+box 两边的工作):
//   1. eptLogin Firewalla 云, 生成 rendezvous rid, 打印激活 URL
//   2. 轮询 rendezvous, 等 msp-mock push 真 MSP QR JSON
//   3. 写 license, 重启 firekick 建 group
//   4. fireWeb.enableWebToken — 在 box 上生成 web eid 并 invite 进 group,
//      拿到 {publicKey, privateKey, gid, license} 四元组
//   5. 代 App 调真 MSP /sandbox/login + /v2/sandbox/add 把 box 入册
//   6. 调真 MSP /sandbox/getMspInfo?from=box 拿 50 年 jwtToken
//   7. 写 Guardian Redis, 通过 FireAPI cmd 触发 Guardian 立刻起 socket.io
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const log = require('../net2/logger.js')(__filename, 'info');

// encipher 客户端 (eptLogin / rendezvousMap / eptGenerateInvite 都在这)
const Cloud = require('../encipher');
const rclient = require('../util/redis_manager.js').getRedisClient();

const rp = require('request-promise');

// box 上"第二套" encipher 身份 — 用来代 App 跑 enableWebToken
const fireWeb = require('../mgmt/FireWeb.js');

const qrcode = require('qrcode-terminal');

// ----------------------------------------------------------------------------
// 配置 & 常量
// ----------------------------------------------------------------------------

// netbot.config 路径: 生产盒子放在 /encipher.config/netbot.config
// (参考 api/lib/CloudWrapper.js / scripts/start_service.sh)
const CONFIG_FILE = process.env.FW_CONFIG || '/encipher.config/netbot.config';

// 默认 mock MSP URL, 用户可以用环境变量覆盖
const DEFAULT_MSP_URL = process.env.MOCK_MSP_URL || 'http://localhost:8888';

// license 文件落盘位置, 由 util/license.js 决定; 这里先 hardcode
// TODO: 改成 require('../util/license.js') 暴露的常量
const LICENSE_FILE = '/home/pi/.firewalla/license';

// 轮询云端 rendezvous 的间隔 (秒)
const POLL_INTERVAL_SEC = 2;

// ----------------------------------------------------------------------------
// 终端输出工具 (ANSI 色 + 美化的 logger)
// ----------------------------------------------------------------------------

const c = {
  reset:  '\x1b[0m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m'
};

const ui = {
  banner(title) {
    const line = '═'.repeat(58);
    console.log('');
    console.log(c.cyan + '╔' + line + '╗' + c.reset);
    const pad = Math.max(0, Math.floor((58 - title.length) / 2));
    const left = ' '.repeat(pad);
    const right = ' '.repeat(58 - title.length - pad);
    console.log(c.cyan + '║' + c.reset + c.bold + left + title + right + c.reset + c.cyan + '║' + c.reset);
    console.log(c.cyan + '╚' + line + '╝' + c.reset);
    console.log('');
  },
  step(n, title) {
    console.log('');
    console.log(c.gray + '─'.repeat(60) + c.reset);
    console.log(c.bold + c.blue + ' Step ' + n + ' · ' + c.reset + c.bold + title + c.reset);
    console.log(c.gray + '─'.repeat(60) + c.reset);
  },
  ok(msg, detail) {
    const d = detail ? c.dim + '  ' + detail + c.reset : '';
    console.log('  ' + c.green + '✓' + c.reset + ' ' + msg + d);
  },
  info(msg) {
    console.log('  ' + c.gray + '·' + c.reset + ' ' + c.gray + msg + c.reset);
  },
  warn(msg) {
    console.log('  ' + c.yellow + '!' + c.reset + ' ' + c.yellow + msg + c.reset);
  },
  err(msg) {
    console.log('  ' + c.red + '✗' + c.reset + ' ' + c.red + msg + c.reset);
  },
  kv(key, value) {
    console.log('  ' + c.gray + key.padEnd(10) + c.reset + c.bold + value + c.reset);
  },
  url(label, url) {
    console.log('');
    console.log('  ' + c.gray + label + c.reset);
    console.log('    ' + c.cyan + c.bold + url + c.reset);
    console.log('');
  }
};

// ----------------------------------------------------------------------------
// 工具函数
// ----------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  return JSON.parse(raw);
}

// ----------------------------------------------------------------------------
// Stage 1: 初始化 ept 客户端 + 云端登录
// ----------------------------------------------------------------------------

async function initCloud(config) {
  const eptcloud = new Cloud(config.endpoint_name || 'netbot', null);
  await eptcloud.loadKeys();

  await eptcloud.eptLogin(
    config.appId,
    config.appSecret,
    null,
    config.endpoint_name
  );

  return eptcloud;
}

// ----------------------------------------------------------------------------
// Stage 2: 生成 rid, 打印 MSP URL 给用户
// ----------------------------------------------------------------------------

function generateInvite(eptcloud, mspUrl) {
  const invite = eptcloud.eptGenerateInvite();
  const rid = invite.r;
  const url = `${mspUrl}/?rid=${rid}`;

  ui.step(2, 'Generate activation request');
  ui.ok('Request ID generated', rid);
  ui.url('Open this URL on your computer to complete activation:', url);
  ui.info(`Polling cloud rendezvous every ${POLL_INTERVAL_SEC}s, waiting for MSP...`);

  return rid;
}

// ----------------------------------------------------------------------------
// Stage 3: 轮询云端 rendezvous, 拿 MSP 写下来的 evalue
// ----------------------------------------------------------------------------

async function pollRendezvous(eptcloud, rid) {
  while (true) {
    try {
      const rinfo = await eptcloud.rendezvousMap(rid);

      if (rinfo && rinfo.evalue) {
        const data = typeof rinfo.evalue === 'string'
          ? JSON.parse(rinfo.evalue)
          : rinfo.evalue;

        console.log('');
        ui.ok('Received activation payload from MSP');
        return data;
      }
    } catch (e) {
      ui.warn(`poll error: ${e.message}`);
    }
    await sleep(POLL_INTERVAL_SEC * 1000);
  }
}

// ----------------------------------------------------------------------------
// Stage 4: 应用 MSP 数据 — 写 license + firekick 建 group + enableWebToken
//          + MSP 入册 + 起 Guardian
//
// evalue 形如:
//   {
//     kind: 'msp_qr',
//     license: '<uuid>',
//     qr: { token, server, seatType, seatLeft, group, expire, type, version, ... }
//   }
// ----------------------------------------------------------------------------

async function applyActivation(data, eptcloud) {
  if (
      !(data && data.license) ||
      !(data && data.qr && data.qr.server) ||
      !(data && data.qr && data.qr.token)
  ) {
    throw new Error('invalid MSP rendezvous payload, expected {license, qr:{token,server}}');
  }
  const { license, qr } = data;
  const server = qr.server;

  ui.step(3, 'Apply activation');

  await writeLicenseFile(license);

  const gid = await waitForGid();
  ui.ok('Using existing GID from sys:ept', gid);

  await eptcloud.eptGroupList();
  const tokenInfo = await fireWeb.enableWebToken(eptcloud);
  ui.ok('Web token enabled', `webEid joined gid ${tokenInfo.gid}`);

  const eptToken = eptcloud.token;
  if (!eptToken) throw new Error('eptcloud.token is empty — eptLogin should have set it');

  const sjwt = await mspSandboxLogin(server, qr.token, eptToken);
  ui.ok('MSP sandbox login OK', '24h sandbox JWT acquired');

  await mspSandboxAdd(server, sjwt, tokenInfo);
  ui.ok('MSP sandbox add OK', 'box registered to MSP');

  const mspInfo = await mspGetInfo(server, eptToken);
  ui.ok('MSP info fetched', `${mspInfo.name} (${mspInfo.id})`);

  await writeGuardianRedis(server, mspInfo);

  await restartFireApi();
  ui.ok('FireAPI restarting', 'Guardian will auto-connect socket.io to MSP in ~10-15s');
}

async function writeLicenseFile(licenseUuid) {
  const payload = JSON.stringify({ DATA: { UUID: licenseUuid } }, null, 2);

  await fs.promises.mkdir(path.dirname(LICENSE_FILE), { recursive: true });
  await fs.promises.writeFile(LICENSE_FILE, payload);

  ui.ok('License written', LICENSE_FILE);
}

async function writeGuardianRedis(server, mspInfo) {
  await rclient.setAsync('ext.guardian.socketio.server', server);
  await rclient.setAsync('ext.guardian.business', JSON.stringify(mspInfo));
  await rclient.setAsync('ext.guardian.socketio.adminStatus', '1');
  ui.ok('Guardian Redis configured', server);
}


async function waitForGid(maxSec = 10) {
  for (let i = 0; i < maxSec; i++) {
    const gid = await rclient.hgetAsync('sys:ept', 'gid');
    if (gid) return gid;
    await sleep(1000);
  }
  throw new Error(
    'sys:ept.gid not found'
  );
}

async function restartFireApi() {
  try {
    await execAsync('sudo systemctl restart fireapi');
  } catch (e) {
    throw new Error(`failed to restart fireapi: ${e.message}`);
  }
}

async function mspSandboxLogin(server, rid, eptToken) {
  const data = await rp({
    uri: `${server}/v1/sandbox/login/${rid}`,
    method: 'POST',
    json: true,
    body: {},
    headers: { Authorization: `Bearer ${eptToken}` },
    timeout: 15000
  });
  if (!data || !data.token) throw new Error('MSP /sandbox/login returned no token');
  return data.token;  // 24h sandbox JWT (iss="fireguard")
}

async function mspSandboxAdd(server, sandboxJwt, payload) {
  await rp({
    uri: `${server}/v2/sandbox/add`,
    method: 'POST',
    json: true,
    body: payload,
    headers: { Authorization: `Bearer ${sandboxJwt}` },
    timeout: 15000
  });
}

async function mspGetInfo(server, eptToken) {
  const data = await rp({
    uri: `${server}/v1/sandbox/getMspInfo`,
    qs: { from: 'box' },
    method: 'GET',
    json: true,
    headers: { Authorization: `Bearer ${eptToken}` },
    timeout: 15000
  });
  if (!data || !data.jwtToken) throw new Error('MSP /sandbox/getMspInfo returned no jwtToken');
  return data;  // {id, name, type, plan, jwtToken: <50年>, ...}
}


// ----------------------------------------------------------------------------
// Stage 5: 收尾, 提示用户激活完成
// ----------------------------------------------------------------------------

function printSuccess(data) {
  ui.banner('  Activation Complete  ');

  ui.kv('License', data.license);
  ui.kv('MSP',     (data.qr && data.qr.server)   || '(unknown)');
  ui.kv('Seat',    (data.qr && data.qr.seatType) || '(unknown)');
  console.log('');

  // 展示 license uuid 的二维码
  console.log('  ' + c.gray + 'License QR ' + c.dim + '(scan to copy)' + c.reset);
  console.log('');
  qrcode.generate(data.license);
  console.log(c.gray + '  Next  →  pair your phone app (FireKick rendezvous, TODO)' + c.reset);
  console.log('');
}

// ----------------------------------------------------------------------------
// 主入口
// ----------------------------------------------------------------------------

async function main() {
  ui.banner('  Firewalla Software Activation  ');

  const config = loadConfig();
  const mspUrl = DEFAULT_MSP_URL;

  ui.step(1, 'Connect to Firewalla cloud');
  const eptcloud = await initCloud(config);
  ui.ok('Logged into Firewalla cloud');

  const rid = generateInvite(eptcloud, mspUrl);

  const data = await pollRendezvous(eptcloud, rid);

  await applyActivation(data, eptcloud);

  printSuccess(data);

  // 清理 Redis 连接, 避免 dangling 让 node 进程 hang
  try { await rclient.quitAsync(); } catch (e) { /* ignore */ }
  process.exit(0);
}

main().catch(err => {
  console.log('');
  console.log('  ' + c.red + '✗ bootstrap failed' + c.reset);
  console.log('  ' + c.red + err.message + c.reset);
  if (err.stack) console.log(c.dim + err.stack + c.reset);
  console.log('');
  process.exit(1);
});
