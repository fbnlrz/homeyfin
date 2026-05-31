#!/usr/bin/env node
// Minimal merge of .homeycompose/ into ./app.json
// (used in environments where `homey app build` isn't run automatically)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const compose = path.join(root, '.homeycompose');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readDirJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ id: path.basename(f, '.json'), data: readJson(path.join(dir, f)) }));
}

const base = readJson(path.join(compose, 'app.json'));

// Capabilities
const caps = readDirJson(path.join(compose, 'capabilities'));
if (caps.length) {
  base.capabilities = base.capabilities ?? {};
  for (const { id, data } of caps) base.capabilities[id] = data;
}

// Flow
const flow = {};
for (const kind of ['triggers', 'conditions', 'actions']) {
  const items = readDirJson(path.join(compose, 'flow', kind)).map(({ id, data }) => ({
    id,
    ...data,
  }));
  if (items.length) flow[kind] = items;
}
if (Object.keys(flow).length) base.flow = flow;

// Drivers (driver.compose.json + pair/*)
const driversDir = path.join(root, 'drivers');
if (fs.existsSync(driversDir)) {
  const drivers = [];
  for (const id of fs.readdirSync(driversDir)) {
    const dDir = path.join(driversDir, id);
    const dCompose = path.join(dDir, 'driver.compose.json');
    if (!fs.existsSync(dCompose)) continue;
    const data = readJson(dCompose);
    data.id = id;
    drivers.push(data);
  }
  if (drivers.length) base.drivers = drivers;
}

// Widgets
const widgetsCompose = path.join(compose, 'widgets');
if (fs.existsSync(widgetsCompose)) {
  base.widgets = base.widgets ?? {};
  for (const id of fs.readdirSync(widgetsCompose)) {
    const w = path.join(widgetsCompose, id, 'widget.compose.json');
    if (fs.existsSync(w)) base.widgets[id] = readJson(w);
  }
}

const out = path.join(root, 'app.json');
fs.writeFileSync(out, JSON.stringify(base, null, 2) + '\n');
console.log('Wrote', out);
