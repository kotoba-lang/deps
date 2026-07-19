#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const GRAPH_PATH = path.join(ROOT, 'src/lib/data/wit-graph.json');
const OUT_MD_PATH = path.join(ROOT, 'src/lib/data/wit-quality-improvement-plan.md');
const OUT_JSON_PATH = path.join(ROOT, 'src/lib/data/wit-quality-audit.json');

function readGraph() {
  const raw = fs.readFileSync(GRAPH_PATH, 'utf8');
  return JSON.parse(raw);
}

function normalizeCount(value) {
  return Number.isFinite(value) ? value : 0;
}

function componentKey(project, componentId) {
  return `${project}::${componentId}`;
}

function isIsolatedLinkerComponent(comp) {
  const imports = Array.isArray(comp.imports) ? comp.imports.length : 0;
  const exports = Array.isArray(comp.exports) ? comp.exports.length : 0;
  const provides = Array.isArray(comp.provides) ? comp.provides.length : 0;
  const requires = Array.isArray(comp.requires) ? comp.requires.length : 0;
  return imports + exports + provides + requires === 0;
}

function buildAudit(graph) {
  const linkerComponents = Array.isArray(graph.linkerStatus?.components) ? graph.linkerStatus.components : [];
  const domainComponents = Array.isArray(graph.domainComponents) ? graph.domainComponents : [];
  const governanceLinks = Array.isArray(graph.governanceLinks) ? graph.governanceLinks : [];

  const capabilityRbacByComponentId = new Map();
  for (const row of domainComponents) {
    const current = capabilityRbacByComponentId.get(row.componentId) || { capabilityCount: 0, rbacCount: 0 };
    current.capabilityCount = Math.max(current.capabilityCount, normalizeCount(row.capabilityCount));
    current.rbacCount = Math.max(current.rbacCount, normalizeCount(row.rbacCount));
    capabilityRbacByComponentId.set(row.componentId, current);
  }

  const governanceByKey = new Map();
  for (const link of governanceLinks) {
    const key = componentKey(link.project, link.componentId);
    governanceByKey.set(key, (governanceByKey.get(key) || 0) + 1);
  }

  const records = [];
  for (const comp of linkerComponents) {
    const key = componentKey(comp.project, comp.componentId);
    const capRbac = capabilityRbacByComponentId.get(comp.componentId) || { capabilityCount: 0, rbacCount: 0 };
    const governanceCount = governanceByKey.get(key) || 0;
    const isolated = isIsolatedLinkerComponent(comp);
    const capabilityMissing = capRbac.capabilityCount === 0;
    const rbacMissing = capRbac.rbacCount === 0;
    const governanceMissing = governanceCount === 0;

    let risk = 0;
    if (isolated) risk += 50;
    if (capabilityMissing) risk += 20;
    if (rbacMissing) risk += 15;
    if (governanceMissing) risk += 15;
    if (capabilityMissing && rbacMissing && governanceMissing) risk += 10;

    records.push({
      project: comp.project,
      componentId: comp.componentId,
      isolated,
      capabilityCount: capRbac.capabilityCount,
      rbacCount: capRbac.rbacCount,
      governanceCount,
      capabilityMissing,
      rbacMissing,
      governanceMissing,
      risk,
    });
  }

  records.sort((a, b) => b.risk - a.risk || a.project.localeCompare(b.project) || a.componentId.localeCompare(b.componentId));

  const totals = {
    totalComponents: records.length,
    isolatedComponents: records.filter(r => r.isolated).length,
    capabilityMissingComponents: records.filter(r => r.capabilityMissing).length,
    rbacMissingComponents: records.filter(r => r.rbacMissing).length,
    governanceMissingComponents: records.filter(r => r.governanceMissing).length,
    tripleMissingComponents: records.filter(r => r.capabilityMissing && r.rbacMissing && r.governanceMissing).length,
    criticalComponents: records.filter(r => r.risk >= 100).length,
  };

  const byProject = new Map();
  for (const r of records) {
    const cur = byProject.get(r.project) || {
      project: r.project,
      totalComponents: 0,
      isolatedComponents: 0,
      capabilityMissingComponents: 0,
      governanceMissingComponents: 0,
      tripleMissingComponents: 0,
      criticalComponents: 0,
    };
    cur.totalComponents += 1;
    if (r.isolated) cur.isolatedComponents += 1;
    if (r.capabilityMissing) cur.capabilityMissingComponents += 1;
    if (r.governanceMissing) cur.governanceMissingComponents += 1;
    if (r.capabilityMissing && r.rbacMissing && r.governanceMissing) cur.tripleMissingComponents += 1;
    if (r.risk >= 100) cur.criticalComponents += 1;
    byProject.set(r.project, cur);
  }

  const projectRows = [...byProject.values()].sort((a, b) => {
    return b.criticalComponents - a.criticalComponents || b.tripleMissingComponents - a.tripleMissingComponents || b.isolatedComponents - a.isolatedComponents;
  });

  const iscoRows = records.filter(r => r.project === 'etzhayyim-project-open-isco');

  return {
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: graph.generatedAt,
    sourceSummary: graph.summary,
    totals,
    topProjects: projectRows.slice(0, 20),
    criticalComponents: records.filter(r => r.risk >= 100).slice(0, 200),
    topRiskComponents: records.slice(0, 200),
    iscoTopRiskComponents: iscoRows.slice(0, 100),
  };
}

function makeMarkdown(audit) {
  const lines = [];
  lines.push('# WIT/WASM Quality Improvement Plan');
  lines.push('');
  lines.push(`- Generated: ${audit.generatedAt}`);
  lines.push(`- Source graph generatedAt: ${audit.sourceGeneratedAt}`);
  lines.push('');
  lines.push('## Global Findings');
  lines.push('');
  lines.push(`- total components: ${audit.totals.totalComponents}`);
  lines.push(`- isolated components: ${audit.totals.isolatedComponents}`);
  lines.push(`- capability missing: ${audit.totals.capabilityMissingComponents}`);
  lines.push(`- RBAC missing: ${audit.totals.rbacMissingComponents}`);
  lines.push(`- governance missing: ${audit.totals.governanceMissingComponents}`);
  lines.push(`- capability+RBAC+governance all missing: ${audit.totals.tripleMissingComponents}`);
  lines.push(`- critical components (risk>=100): ${audit.totals.criticalComponents}`);
  lines.push('');

  lines.push('## P0 Target Projects (by critical count)');
  lines.push('');
  lines.push('| project | critical | triple-missing | isolated | total |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const p of audit.topProjects.slice(0, 15)) {
    lines.push(`| ${p.project} | ${p.criticalComponents} | ${p.tripleMissingComponents} | ${p.isolatedComponents} | ${p.totalComponents} |`);
  }
  lines.push('');

  lines.push('## P0 Critical Components (Top 30)');
  lines.push('');
  lines.push('| project | componentId | risk | isolated | cap | rbac | gov |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const c of audit.criticalComponents.slice(0, 30)) {
    lines.push(`| ${c.project} | ${c.componentId} | ${c.risk} | ${c.isolated ? 'yes' : 'no'} | ${c.capabilityCount} | ${c.rbacCount} | ${c.governanceCount} |`);
  }
  lines.push('');

  lines.push('## ISCO Focus (Top 30 by risk)');
  lines.push('');
  lines.push('| componentId | risk | isolated | cap | rbac | gov |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const c of audit.iscoTopRiskComponents.slice(0, 30)) {
    lines.push(`| ${c.componentId} | ${c.risk} | ${c.isolated ? 'yes' : 'no'} | ${c.capabilityCount} | ${c.rbacCount} | ${c.governanceCount} |`);
  }
  lines.push('');

  lines.push('## Improvement Plan');
  lines.push('');
  lines.push('1. P0 (1-2 weeks): Add capability tags and Responsible/Accountable/RequireApproval metadata to all critical components, starting from the top 3 projects.');
  lines.push('2. P1 (2-4 weeks): Remove isolation by wiring command/query links for components that are isolated but should participate in runtime/domain graph.');
  lines.push('3. P2 (continuous): Add per-project CI gate to fail when new component has cap=0 or gov=0 without explicit allowlist.');
  lines.push('4. P2 (continuous): Regenerate full-audit weekly and track trend of isolated/triple-missing/critical counts.');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function main() {
  const graph = readGraph();
  const audit = buildAudit(graph);
  fs.writeFileSync(OUT_JSON_PATH, JSON.stringify(audit, null, 2) + '\n');
  fs.writeFileSync(OUT_MD_PATH, makeMarkdown(audit));
  console.log(`Generated ${OUT_JSON_PATH}`);
  console.log(`Generated ${OUT_MD_PATH}`);
  console.log(`Critical components: ${audit.totals.criticalComponents}`);
}

main();
