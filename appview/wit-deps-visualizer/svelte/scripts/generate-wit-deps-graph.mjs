/**
 * Generate WIT dependency graph data from the kotodama runtime WIT interfaces,
 * project-level component WIT worlds, and cross-domain dependency/RBAC/capability
 * declarations for ISCO / ISIC / APQC / Tsukuru classification systems.
 *
 * Outputs: src/lib/data/wit-graph.json
 *
 * Data model:
 *   - runtime world (kotodama-component): the central wasmtime linker contract
 *   - packages: WIT package namespaces (kotodama:core, kotodama:auth, etc.)
 *   - interfaces: individual WIT interfaces within packages
 *   - host implementations: Rust host crates that back each interface
 *   - project components: WASM apps that include the runtime world
 *   - domainGraph: cross-domain dependency edges (isco/isic/apqc/tsukuru)
 *   - rbacBindings: RACI role bindings extracted from main.go Command() declarations
 *   - capabilities: capability entries extracted from main.go AsAgentTool/WithCapabilityTags
 *   - governanceLinks: implemented governance declarations across all projects
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = findRepositoryRoot(CURRENT_DIR);
const OUTPUT_PATH = path.join(CURRENT_DIR, '..', 'src', 'lib', 'data', 'wit-graph.json');

// Core WIT paths
const KOTODAMA_WIT_DIR = path.join(SOURCE_ROOT, 'packages', 'rust', 'kotodama', 'wit');
const KOTODAMA_WORLD_WIT = path.join(KOTODAMA_WIT_DIR, 'world.wit');
const KOTODAMA_DEPS_DIR = path.join(KOTODAMA_WIT_DIR, 'deps');
const WASM_WORLD_DIR = path.join(SOURCE_ROOT, 'packages', 'wasm', 'world');
const PROJECTS_ROOT = path.join(SOURCE_ROOT, 'projects');
const HOST_SRC_DIR = path.join(SOURCE_ROOT, 'packages', 'rust', 'kotodama', 'kotodama-engine', 'src', 'host');

// Domain targets: include every projects/*/wasm directory as a scored domain.
const DOMAIN_PROJECTS = discoverDomainProjects(PROJECTS_ROOT);

const DOMAIN_META = {
	isco: { label: 'ISCO-08', witPkg: 'etzhayyim:isco-*', description: 'Occupation performer agents', color: '#3b82f6' },
	isic: { label: 'ISIC Rev.4', witPkg: 'etzhayyim:isic-*', description: 'Industry classification interfaces', color: '#10b981' },
	apqc: { label: 'APQC PCF', witPkg: 'etzhayyim:apqc-*', description: 'Process classification framework', color: '#f59e0b' },
	tsukuru: { label: 'Tsukuru', witPkg: 'etzhayyim:tsukuru*', description: 'B2B factory-direct marketplace', color: '#ef4444' },
	'tukuru-process': { label: 'Tukuru Process', witPkg: 'etzhayyim:tukuru-process*', description: 'Manufacturing process lifecycle', color: '#ec4899' },
	bpmn: { label: 'BPMN', witPkg: 'etzhayyim:bpmn-*', description: 'Cross-domain process definitions', color: '#8b5cf6' },
	resources: { label: 'Resources', witPkg: 'etzhayyim:resources*', description: 'Entity/resource graph', color: '#06b6d4' },
	states: { label: 'States', witPkg: 'etzhayyim:states*', description: 'Government/state domain', color: '#0ea5e9' },
	cpc: { label: 'CPC', witPkg: 'etzhayyim:cpc*', description: 'Central Product Classification domain', color: '#22c55e' },
	unispsc: { label: 'UniSPSC', witPkg: 'etzhayyim:unispsc*', description: 'UniSPSC taxonomy/classification domain', color: '#fb7185' },
	governance: { label: 'Governance', witPkg: 'kotodama:agent/governance', description: 'RACI, RBAC, policy-gate, capability governance', color: '#ec4899' },
};

const DOMAIN_COLOR_POOL = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#14b8a6', '#f97316', '#eab308', '#a855f7'];

const FULL_AUDIT = process.env.WIT_FULL_AUDIT === '1';
const DEFAULT_DEEP_SCAN_LIMIT = 20;
const DEFAULT_DOMAIN_COMPONENT_TRIM_LIMIT = 50;

// Max components to deep-scan per domain (read main.go for RBAC/capabilities)
// Large domains (isco: 715+, states: 1000+) sample first N to avoid slow I/O
const DEEP_SCAN_LIMIT = FULL_AUDIT
	? Number.MAX_SAFE_INTEGER
	: parsePositiveIntEnv('WIT_DEEP_SCAN_LIMIT', DEFAULT_DEEP_SCAN_LIMIT);
const DOMAIN_COMPONENT_TRIM_LIMIT = FULL_AUDIT
	? 0
	: parsePositiveIntEnv('WIT_DOMAIN_COMPONENT_TRIM_LIMIT', DEFAULT_DOMAIN_COMPONENT_TRIM_LIMIT);

// WIT package prefix → domain mapping
const PKG_DOMAIN_MAP = {
	'etzhayyim:isco': 'isco',
	'etzhayyim:isic': 'isic',
	'etzhayyim:apqc': 'apqc',
	'etzhayyim:tsukuru': 'tsukuru',
	'etzhayyim:tukuru-process': 'tukuru-process',
	'etzhayyim:supply-chain': 'isic',
	'etzhayyim:bpmn': 'bpmn',
	'etzhayyim:cpc': 'cpc',
	'etzhayyim:unispc': 'unispsc',
	'etzhayyim:unispsc': 'unispsc',
};

function main() {
	const graph = {
		generatedAt: new Date().toISOString(),
		runtimeWorld: null,
		packages: [],
		interfaces: [],
		hostImpls: [],
		projectSummary: [],
		registeredApps: [],
		edges: [],
		legacyWorlds: [],
		// New: cross-domain dependency/RBAC/capability data
		domainGraph: {
			domains: [],
			dependencies: [],
		},
		rbacBindings: [],
		capabilities: [],
		domainComponents: [],
		governanceLinks: [],
		linkerStatus: {
			components: [],
			links: [],
			summary: {
				totalComponents: 0,
				totalLinks: 0,
				resolvedLinks: 0,
				unresolvedLinks: 0,
			},
		},
		scorecard: {
			method: '',
			overallScore: 0,
			workerRegisteredAppCount: 0,
			workerDeployedAppCount: 0,
			workerDeployCoverageRate: 0,
			wprotoIntegrationScore: 0,
			isolatedComponentsCount: 0,
			isolatedComponentsRate: 0,
			governanceCoverageRate: 0,
			explicitRaciCoverageRate: 0,
			linkCoverageRate: 0,
			unresolvedRate: 0,
			governanceUnresolvedCount: 0,
			unresolvedByKind: {},
			governanceUnresolvedNodes: [],
			topUnresolvedNodes: [],
			topIsolatedNodes: [],
			topIsolatedProjects: [],
		},
	};

	// 1. Parse the core kotodama-component world
	const worldData = parseWorldWit(KOTODAMA_WORLD_WIT);
	graph.runtimeWorld = {
		id: 'kotodama:runtime@1.0.0/kotodama-component',
		package: worldData.packageName,
		name: 'kotodama-component',
		imports: worldData.imports.map(normalizeRef),
		exports: worldData.exports.map(normalizeRef),
	};

	// 2. Parse all WIT dep packages
	if (fs.existsSync(KOTODAMA_DEPS_DIR)) {
		for (const dir of fs.readdirSync(KOTODAMA_DEPS_DIR, { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			const pkgDir = path.join(KOTODAMA_DEPS_DIR, dir.name);
			const witFiles = collectWitFiles(pkgDir);
			for (const witFile of witFiles) {
				const parsed = parseWitFile(witFile);
				if (!parsed.packageName) continue;

				const pkgId = parsed.packageName;
				let pkg = graph.packages.find(p => p.id === pkgId);
				if (!pkg) {
					pkg = { id: pkgId, dirName: dir.name, interfaces: [] };
					graph.packages.push(pkg);
				}

				for (const iface of parsed.interfaces) {
					const existing = pkg.interfaces.find(i => i.name === iface.name);
					if (!existing) {
						pkg.interfaces.push({
							name: iface.name,
							fullId: `${pkgId}/${iface.name}`,
							functions: iface.functions,
							records: iface.records,
							enums: iface.enums,
							source: path.relative(SOURCE_ROOT, witFile),
						});
						graph.interfaces.push({
							id: `${pkgId}/${iface.name}`,
							package: pkgId,
							name: iface.name,
							functionCount: iface.functions.length,
							recordCount: iface.records.length,
							enumCount: iface.enums.length,
						});
					}
				}
			}
		}
	}

	// 3. Parse WASI standard packages from deps
	const wasiPackages = ['cli', 'clocks', 'filesystem', 'http', 'io', 'random', 'sockets'];
	for (const wasiPkg of wasiPackages) {
		const wasiDir = path.join(KOTODAMA_DEPS_DIR, wasiPkg);
		if (!fs.existsSync(wasiDir)) continue;
		const witFiles = collectWitFiles(wasiDir);
		for (const witFile of witFiles) {
			const parsed = parseWitFile(witFile);
			if (!parsed.packageName) continue;
			const pkgId = parsed.packageName;
			let pkg = graph.packages.find(p => p.id === pkgId);
			if (!pkg) {
				pkg = { id: pkgId, dirName: wasiPkg, interfaces: [], isWasi: true };
				graph.packages.push(pkg);
			}
			for (const iface of parsed.interfaces) {
				const existing = pkg.interfaces.find(i => i.name === iface.name);
				if (!existing) {
					pkg.interfaces.push({
						name: iface.name,
						fullId: `${pkgId}/${iface.name}`,
						functions: iface.functions,
						records: iface.records,
						enums: iface.enums,
						source: path.relative(SOURCE_ROOT, witFile),
					});
					graph.interfaces.push({
						id: `${pkgId}/${iface.name}`,
						package: pkgId,
						name: iface.name,
						functionCount: iface.functions.length,
						recordCount: iface.records.length,
						enumCount: iface.enums.length,
						isWasi: true,
					});
				}
			}
		}
	}

	// 4. Parse host implementations (Rust files)
	if (fs.existsSync(HOST_SRC_DIR)) {
		for (const file of fs.readdirSync(HOST_SRC_DIR)) {
			if (!file.endsWith('.rs')) continue;
			const hostName = file.replace('.rs', '');
			const content = fs.readFileSync(path.join(HOST_SRC_DIR, file), 'utf8');
			const hostTraits = [...content.matchAll(/impl\s+(?:[\w:]+::)*(\w+)::Host\s+for\s+ComponentState/g)]
				.map(m => m[1]);
			graph.hostImpls.push({
				name: hostName,
				file: `packages/rust/kotodama/kotodama-engine/src/host/${file}`,
				traits: hostTraits,
			});
		}
	}

	// 5. Build edges: runtime world → interfaces
	for (const imp of graph.runtimeWorld.imports) {
		graph.edges.push({
			source: graph.runtimeWorld.id,
			target: imp,
			kind: 'import',
			label: 'wasmtime linker provides',
		});
	}
	for (const exp of graph.runtimeWorld.exports) {
		graph.edges.push({
			source: exp,
			target: graph.runtimeWorld.id,
			kind: 'export',
			label: 'component exports',
		});
	}

	// 6. Scan project components (summary + cross-domain analysis)
	const { count: componentCount, projectSummary, componentDetails } = scanProjectComponents(graph);
	graph.projectSummary = projectSummary;
	graph.linkerStatus = buildLinkerStatus(componentDetails, graph.runtimeWorld.imports);
	graph.registeredApps = componentDetails
		.filter(component => component.registeredApp)
		.map(component => ({
			project: component.project,
			componentId: component.componentId,
			appId: component.appId,
			appName: component.appName,
			runtime: component.runtime,
			registeredApp: component.registeredApp,
			workerDeployed: component.workerDeployed,
			routeHosts: component.routeHosts,
			wprotoIntegrationScore: component.wprotoIntegrationScore,
			wprotoSignals: component.wprotoSignals,
		}))
		.sort((a, b) =>
			Number(b.workerDeployed) - Number(a.workerDeployed) ||
			(b.wprotoIntegrationScore ?? 0) - (a.wprotoIntegrationScore ?? 0) ||
			a.project.localeCompare(b.project) ||
			a.componentId.localeCompare(b.componentId)
		);

	// 7. Parse legacy etzhayyim:platform worlds
	if (fs.existsSync(WASM_WORLD_DIR)) {
		for (const file of fs.readdirSync(WASM_WORLD_DIR)) {
			if (!file.endsWith('.wit')) continue;
			const parsed = parseWorldWit(path.join(WASM_WORLD_DIR, file));
			if (parsed.packageName) {
				graph.legacyWorlds.push({
					id: parsed.packageName,
					file: `packages/wasm/world/${file}`,
					imports: parsed.imports.map(normalizeRef),
					exports: parsed.exports.map(normalizeRef),
				});
			}
		}
	}

	// 8. Build cross-domain dependency graph (isco/isic/apqc/tsukuru)
	buildDomainGraph(graph);

	// 9. Scan domain components for RBAC and capabilities
	scanDomainComponentDetails(graph);

	// 10. Scan all project components for implemented governance links
	scanGovernanceLinks(graph);
	graph.scorecard = buildScorecard(graph);

	graph.summary = {
		totalPackages: graph.packages.length,
		totalInterfaces: graph.interfaces.length,
		totalHostImpls: graph.hostImpls.length,
		totalProjectComponents: componentCount,
		totalEdges: graph.edges.length,
		runtimeImports: graph.runtimeWorld.imports.length,
		runtimeExports: graph.runtimeWorld.exports.length,
		totalDomainDeps: graph.domainGraph.dependencies.length,
		totalRbacBindings: graph.rbacBindings.length,
		totalCapabilities: graph.capabilities.length,
		totalDomainComponents: graph.domainComponents.length,
		totalGovernanceLinks: graph.governanceLinks.length,
		totalGovernedComponents: new Set(graph.governanceLinks.map(link => `${link.project}/${link.componentId}`)).size,
		totalLinkerComponents: graph.linkerStatus.summary.totalComponents,
		totalRegisteredApps: graph.registeredApps.length,
		totalWorkerDeployedApps: graph.scorecard.workerDeployedAppCount,
		totalIsolatedComponents: graph.scorecard.isolatedComponentsCount,
		totalResolvedLinks: graph.linkerStatus.summary.resolvedLinks,
		totalUnresolvedLinks: graph.linkerStatus.summary.unresolvedLinks,
		workerDeployCoverageRate: graph.scorecard.workerDeployCoverageRate,
		wprotoIntegrationScore: graph.scorecard.wprotoIntegrationScore,
		isolatedComponentsRate: graph.scorecard.isolatedComponentsRate,
		governanceCoverageRate: graph.scorecard.governanceCoverageRate,
		explicitRaciCoverageRate: graph.scorecard.explicitRaciCoverageRate,
		governanceUnresolvedCount: graph.scorecard.governanceUnresolvedCount,
		depsOverallScore: graph.scorecard.overallScore,
		appWitDefinitionScore: graph.scorecard.appWitDefinitionScore,
	};

	// Trim domainComponents by domain unless full-audit mode is enabled.
	if (DOMAIN_COMPONENT_TRIM_LIMIT > 0) {
		const trimmedComponents = [];
		const domainIds = [...new Set(graph.domainComponents.map(c => c.domain))];
		for (const domain of domainIds) {
			const domComps = graph.domainComponents.filter(c => c.domain === domain);
			trimmedComponents.push(...domComps.slice(0, DOMAIN_COMPONENT_TRIM_LIMIT));
		}
		graph.domainComponents = trimmedComponents;
	}

	fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
	fs.writeFileSync(OUTPUT_PATH, JSON.stringify(graph) + '\n');
	console.log(`Generated ${OUTPUT_PATH}`);
	console.log(`  packages: ${graph.packages.length}, interfaces: ${graph.interfaces.length}`);
	console.log(`  host impls: ${graph.hostImpls.length}, project components: ${componentCount}`);
	console.log(`  edges: ${graph.edges.length}`);
	console.log(`  domain deps: ${graph.domainGraph.dependencies.length}, rbac: ${graph.rbacBindings.length}, capabilities: ${graph.capabilities.length}`);
	console.log(`  domain components: ${graph.domainComponents.length}`);
	console.log(`  governance links: ${graph.governanceLinks.length}`);
	console.log(`  linker links: ${graph.linkerStatus.summary.resolvedLinks} resolved / ${graph.linkerStatus.summary.unresolvedLinks} unresolved`);
	console.log(`  worker deployed apps: ${graph.scorecard.workerDeployedAppCount}/${graph.registeredApps.length}`);
	console.log(`  isolated components: ${graph.scorecard.isolatedComponentsCount}`);
	console.log(`  wproto integration score: ${graph.scorecard.wprotoIntegrationScore}`);
	console.log(`  deps score: ${graph.scorecard.overallScore}`);
	console.log(`  mode: ${FULL_AUDIT ? 'full-audit' : 'default'} (deep_scan_limit=${DEEP_SCAN_LIMIT}, trim_limit=${DOMAIN_COMPONENT_TRIM_LIMIT || 'off'})`);
}

function parsePositiveIntEnv(name, fallback) {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return value;
}

// ── Cross-domain dependency graph builder ─────────────────

function buildDomainGraph(graph) {
	const domains = Object.keys(DOMAIN_PROJECTS)
		.sort((a, b) => a.localeCompare(b))
		.map(domainId => makeDomainNode(domainId));
	if (!domains.some(domain => domain.id === 'governance')) {
		domains.push(makeDomainNode('governance'));
	}

	// Count components per domain
	for (const [domainId, projectDir] of Object.entries(DOMAIN_PROJECTS)) {
		const wasmRoot = path.join(PROJECTS_ROOT, projectDir, 'wasm');
		if (!fs.existsSync(wasmRoot)) continue;
		let count = 0;
		for (const comp of fs.readdirSync(wasmRoot, { withFileTypes: true })) {
			if (!comp.isDirectory()) continue;
			if (fs.existsSync(path.join(wasmRoot, comp.name, 'main.go')) ||
				fs.existsSync(path.join(wasmRoot, comp.name, 'kotodama.toml'))) {
				count++;
			}
		}
		const domain = domains.find(d => d.id === domainId);
		if (domain) domain.componentCount = count;
	}

	graph.domainGraph.domains = domains;

	// Scan world.wit files for cross-domain imports/exports (sample first N per domain)
	const deps = [];
	for (const [domainId, projectDir] of Object.entries(DOMAIN_PROJECTS)) {
		const wasmRoot = path.join(PROJECTS_ROOT, projectDir, 'wasm');
		if (!fs.existsSync(wasmRoot)) continue;

		let witScanned = 0;
		for (const comp of fs.readdirSync(wasmRoot, { withFileTypes: true })) {
			if (!comp.isDirectory()) continue;
			if (witScanned >= DEEP_SCAN_LIMIT) break;
			const worldWit = path.join(wasmRoot, comp.name, 'wit', 'world.wit');
			if (!fs.existsSync(worldWit)) continue;
			witScanned++;

			const worldData = parseWorldWit(worldWit);
			for (const imp of worldData.imports) {
				const ref = normalizeRef(imp);
				const targetDomain = resolveDomain(ref);
				if (targetDomain && targetDomain !== domainId) {
					deps.push({
						source: domainId,
						target: targetDomain,
						kind: 'wit-import',
						interfaceRef: ref,
						component: comp.name,
						description: `${comp.name} imports ${ref}`,
					});
				}
			}
			for (const exp of worldData.exports) {
				const ref = normalizeRef(exp);
				const targetDomain = resolveDomain(ref);
				if (targetDomain && targetDomain !== domainId) {
					deps.push({
						source: domainId,
						target: targetDomain,
						kind: 'wit-export',
						interfaceRef: ref,
						component: comp.name,
						description: `${comp.name} exports ${ref}`,
					});
				}
			}
		}
	}

	// Add known cross-project Connect gRPC dependencies
	const grpcDeps = [
		{ source: 'tsukuru', target: 'resources', kind: 'grpc-call', interfaceRef: 'etzhayyim.supply_company.v1.SupplyCompanyService/CreateResource', description: 'Supplier sync: RegisterSupplier → CreateResource' },
		{ source: 'tsukuru', target: 'isic', kind: 'conversation-discover', interfaceRef: 'etzhayyim:isic-c/*', description: 'ISIC Section C manufacturing coordinators' },
		{ source: 'bpmn', target: 'resources', kind: 'conversation-discover', interfaceRef: 'resources domain BPMN source', description: 'BPMN generation from resources entity graph' },
		{ source: 'bpmn', target: 'tsukuru', kind: 'conversation-discover', interfaceRef: 'tsukuru domain BPMN source', description: 'BPMN generation from tsukuru manufacturing/RFQ' },
		{ source: 'bpmn', target: 'isco', kind: 'conversation-discover', interfaceRef: 'isco domain BPMN source', description: 'BPMN generation from ISCO occupational workflows' },
		{ source: 'bpmn', target: 'apqc', kind: 'conversation-discover', interfaceRef: 'apqc domain BPMN source', description: 'BPMN generation from APQC process classification' },
		{ source: 'isco', target: 'apqc', kind: 'conversation-call', interfaceRef: 'ISCO performer → APQC process executor', description: 'ISCO occupation agents execute APQC business processes' },
		{ source: 'apqc', target: 'isic', kind: 'conversation-call', interfaceRef: 'APQC process → ISIC industry actor', description: 'APQC processes operate within ISIC industry contexts' },
		{ source: 'isic', target: 'tsukuru', kind: 'conversation-call', interfaceRef: 'ISIC C/F → Tsukuru factory ops', description: 'ISIC manufacturing/construction actors invoke Tsukuru factory operations' },
		{ source: 'states', target: 'isco', kind: 'conversation-discover', interfaceRef: 'gov org → ISCO COFOG actors', description: 'Government org components discover ISCO-classified actors' },
	];

	graph.domainGraph.dependencies = [...deps, ...grpcDeps];
}

function resolveDomain(ref) {
	for (const [prefix, domain] of Object.entries(PKG_DOMAIN_MAP)) {
		if (ref.startsWith(prefix)) return domain;
	}
	const pkgMatch = String(ref).match(/^etzhayyim:([a-z0-9-]+)/i);
	if (pkgMatch) {
		const inferred = pkgMatch[1].toLowerCase();
		if (DOMAIN_PROJECTS[inferred]) return inferred;
	}
	return null;
}

// ── Domain component detail scanner (RBAC + capabilities) ─

function scanDomainComponentDetails(graph) {
	for (const [domainId, projectDir] of Object.entries(DOMAIN_PROJECTS)) {
		const wasmRoot = path.join(PROJECTS_ROOT, projectDir, 'wasm');
		if (!fs.existsSync(wasmRoot)) continue;

		const allComps = fs.readdirSync(wasmRoot, { withFileTypes: true })
			.filter(d => d.isDirectory());

		let deepScanned = 0;

		for (const comp of allComps) {
			const mainGo = path.join(wasmRoot, comp.name, 'main.go');
			if (!fs.existsSync(mainGo)) continue;

			// For large domains, only deep-scan first N components (read main.go)
			const doDeepScan = deepScanned < DEEP_SCAN_LIMIT;
			deepScanned++;

			const classCode = extractClassificationCode(comp.name, domainId);

			if (doDeepScan) {
				const content = fs.readFileSync(mainGo, 'utf8');
				const worldWit = path.join(wasmRoot, comp.name, 'wit', 'world.wit');
				let imports = [];
				let exports = [];
				let witWorld = null;

				if (fs.existsSync(worldWit)) {
					const wd = parseWorldWit(worldWit);
					imports = wd.imports.map(normalizeRef);
					exports = wd.exports.map(normalizeRef);
					witWorld = wd.packageName;
				}

				const rbac = extractRBAC(content, domainId, comp.name);
				graph.rbacBindings.push(...rbac);

				const caps = extractCapabilities(content, domainId, comp.name);
				graph.capabilities.push(...caps);

				graph.domainComponents.push({
					componentId: comp.name,
					name: extractServiceName(content) || comp.name,
					domain: domainId,
					classificationCode: classCode,
					witWorld,
					imports,
					exports,
					capabilityCount: caps.length,
					rbacCount: rbac.length,
				});
			} else {
				// Shallow entry (no main.go read)
				graph.domainComponents.push({
					componentId: comp.name,
					name: comp.name,
					domain: domainId,
					classificationCode: classCode,
					witWorld: null,
					imports: [],
					exports: [],
					capabilityCount: 0,
					rbacCount: 0,
				});
			}
		}
	}
}

function extractRBAC(content, domainId, componentId) {
	const bindings = [];
	for (const block of extractCommandBlocks(content)) {
		const cmdName = extractCommandName(block);
		if (!cmdName) continue;
		for (const link of extractGovernanceRelations(block)) {
			if (!['responsible', 'accountable', 'consulted', 'informed', 'approval'].includes(link.relation)) continue;
			bindings.push({
				domain: domainId,
				componentId,
				command: cmdName,
				role: link.relation,
				assigneeValue: link.target,
			});
		}
	}

	return bindings;
}

function extractCapabilities(content, domainId, componentId) {
	const caps = [];
	let m;

	for (const block of extractCommandBlocks(content)) {
		const cmdName = extractCommandName(block);
		if (!cmdName) continue;
		const toolMatch = block.match(/kotodama\.AsAgentTool\(\s*"([^"]+)"\s*\)/s);
		if (toolMatch) {
			caps.push({
				domain: domainId,
				componentId,
				name: cmdName,
				description: toolMatch[1],
				tags: [],
				status: 'operational',
				a2aDiscoverable: true,
			});
		}

		const tagMatch = block.match(/kotodama\.WithCapabilityTags\(([\s\S]*?)\)/s);
		if (!tagMatch) continue;
		const tags = [...tagMatch[1].matchAll(/"([^"]+)"/g)].map(t => t[1]);
		const existing = caps.find(c => c.name === cmdName && c.componentId === componentId);
		if (existing) {
			existing.tags = tags;
		} else {
			caps.push({
				domain: domainId,
				componentId,
				name: cmdName,
				description: '',
				tags,
				status: 'operational',
				a2aDiscoverable: tags.length > 0,
			});
		}
	}

	// Fallback: extract MCP tools from var mcpTools or var tools
	if (caps.length === 0) {
		const mcpPattern = /\{Name:\s*"([^"]+)",\s*Description:\s*"([^"]+)"\}/g;
		while ((m = mcpPattern.exec(content))) {
			caps.push({
				domain: domainId,
				componentId,
				name: m[1],
				description: m[2],
				tags: [domainId],
				status: 'operational',
				a2aDiscoverable: true,
			});
		}
	}

	return caps;
}

function scanGovernanceLinks(graph) {
	const governedComponents = new Set();
	const domainGovernanceEdges = new Set();

	for (const project of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		const wasmRoot = path.join(PROJECTS_ROOT, project.name, 'wasm');
		if (!fs.existsSync(wasmRoot)) continue;

		for (const comp of fs.readdirSync(wasmRoot, { withFileTypes: true })) {
			if (!comp.isDirectory()) continue;
			const mainGo = path.join(wasmRoot, comp.name, 'main.go');
			if (!fs.existsSync(mainGo)) continue;

			let content;
			try {
				content = fs.readFileSync(mainGo, 'utf8');
			} catch {
				continue;
			}

			const domain = resolveProjectDomain(project.name);
			const componentName = extractServiceName(content) || comp.name;
			let componentHasGovernance = false;
			const commandNames = [];

			for (const block of extractCommandBlocks(content)) {
				const command = extractCommandName(block);
				if (!command) continue;
				commandNames.push(command);
				for (const relation of extractGovernanceRelations(block)) {
					componentHasGovernance = true;
					graph.governanceLinks.push({
						project: project.name,
						domain,
						componentId: comp.name,
						componentName,
						command,
						relation: relation.relation,
						target: relation.target,
						file: path.relative(SOURCE_ROOT, mainGo),
					});
				}
			}

			const governedComponentKey = `${project.name}/${comp.name}`;
			if (!componentHasGovernance && commandNames.length === 0) continue;

			// Components with Command() handlers but without explicit RACI metadata
			// are treated as governance-managed by baseline runtime policy.
			if (!componentHasGovernance && commandNames.length > 0) {
				const sample = [...new Set(commandNames)].slice(0, 5);
				graph.governanceLinks.push({
					project: project.name,
					domain,
					componentId: comp.name,
					componentName,
					command: sample[0] || '',
					relation: 'inferred-command-policy',
					target: `${commandNames.length} commands (${sample.join(', ')})`,
					file: path.relative(SOURCE_ROOT, mainGo),
				});
			}

			governedComponents.add(governedComponentKey);

			if (domain) {
				const edgeKey = `${domain}|governance|${project.name}/${comp.name}`;
				if (domainGovernanceEdges.has(edgeKey)) continue;
				domainGovernanceEdges.add(edgeKey);
				graph.domainGraph.dependencies.push({
					source: domain,
					target: 'governance',
					kind: 'governance',
					interfaceRef: 'kotodama:agent/governance@1.0.0',
					component: comp.name,
					description: `${comp.name} declares governance metadata via Command() options`,
				});
			}
		}
	}

	// Inferred governance coverage:
	// Components that explicitly import/require governance interfaces are treated
	// as governed even when they do not embed RACI declarations in Command() options.
	for (const component of graph.linkerStatus?.components ?? []) {
		const componentKey = `${component.project}/${component.componentId}`;
		if (governedComponents.has(componentKey)) continue;

		const inferredRefs = inferGovernanceRefs(component);
		if (inferredRefs.length === 0) continue;

		const domain = resolveProjectDomain(component.project);
		governedComponents.add(componentKey);
		graph.governanceLinks.push({
			project: component.project,
			domain,
			componentId: component.componentId,
			componentName: component.componentId,
			command: '',
			relation: 'inferred-governance',
			target: inferredRefs.join(', '),
			file: '',
		});

		if (domain) {
			const edgeKey = `${domain}|governance|${component.project}/${component.componentId}`;
			if (!domainGovernanceEdges.has(edgeKey)) {
				domainGovernanceEdges.add(edgeKey);
				graph.domainGraph.dependencies.push({
					source: domain,
					target: 'governance',
					kind: 'governance',
					interfaceRef: inferredRefs[0] || 'kotodama:agent/governance@1.0.0',
					component: component.componentId,
					description: `${component.componentId} references governance interfaces via WIT imports/requires`,
				});
			}
		}
	}

	const governanceNode = graph.domainGraph.domains.find(domain => domain.id === 'governance');
	if (governanceNode) {
		governanceNode.componentCount = governedComponents.size;
	}
}

function inferGovernanceRefs(component) {
	const refs = new Set();
	for (const ref of component.imports ?? []) {
		if (isGovernanceRef(ref)) refs.add(ref);
	}
	for (const req of component.requires ?? []) {
		if (!req) continue;
		const ref = `${req.package}/${req.interface}`;
		if (isGovernanceRef(ref)) refs.add(ref);
	}
	return [...refs].sort();
}

function isGovernanceRef(ref) {
	if (!ref) return false;
	const s = String(ref).toLowerCase();
	return s.includes('governance') || s.includes('policy-gate');
}

function extractClassificationCode(compName, domainId) {
	if (domainId === 'isco') {
		const m = compName.match(/isco-(\d{4})/);
		return m ? `ISCO-${m[1]}` : '';
	}
	if (domainId === 'isic') {
		const m = compName.match(/isic-([a-z](?:-\d+)*)/i);
		return m ? `ISIC-${m[1].toUpperCase()}` : '';
	}
	if (domainId === 'apqc') {
		const m = compName.match(/apqc-(\d+(?:-\d+)*)/);
		return m ? `APQC-${m[1]}` : '';
	}
	if (domainId === 'tsukuru') {
		const m = compName.match(/proc-(\w+)/);
		return m ? `PROC-${m[1].toUpperCase()}` : 'TSUKURU';
	}
	return '';
}

function extractServiceName(content) {
	const m = content.match(/serviceName\s*=\s*"([^"]+)"/);
	if (m) return m[1];
	const m2 = content.match(/Name:\s*"([^"]+)"/);
	return m2 ? m2[1] : null;
}

function resolveProjectDomain(projectName) {
	for (const [domainId, dirName] of Object.entries(DOMAIN_PROJECTS)) {
		if (projectName === dirName) return domainId;
	}
	return null;
}

function discoverDomainProjects(projectsRoot) {
	const result = {};
	if (!fs.existsSync(projectsRoot)) return result;
	for (const project of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		const wasmRoot = path.join(projectsRoot, project.name, 'wasm');
		if (!fs.existsSync(wasmRoot)) continue;
		const domainId = normalizeProjectDomain(project.name);
		result[domainId] = project.name;
	}
	return result;
}

function normalizeProjectDomain(projectName) {
	const prefix = 'etzhayyim-project-';
	if (projectName.startsWith(prefix)) {
		return projectName.slice(prefix.length);
	}
	return projectName;
}

function makeDomainNode(domainId) {
	const meta = DOMAIN_META[domainId];
	if (meta) {
		return {
			id: domainId,
			label: meta.label,
			witPkg: meta.witPkg,
			description: meta.description,
			componentCount: 0,
			color: meta.color,
		};
	}
	const label = domainId
		.split('-')
		.map(part => part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part)
		.join(' ');
	const color = DOMAIN_COLOR_POOL[hashString(domainId) % DOMAIN_COLOR_POOL.length];
	return {
		id: domainId,
		label,
		witPkg: `etzhayyim:${domainId}*`,
		description: `${label} project domain`,
		componentCount: 0,
		color,
	};
}

function hashString(value) {
	let h = 0;
	for (let i = 0; i < value.length; i++) {
		h = ((h << 5) - h + value.charCodeAt(i)) | 0;
	}
	return Math.abs(h);
}

function extractCommandBlocks(content) {
	const blocks = [];
	const commandCallLineRegex = /(^|\n)\s*([A-Za-z_]\w*)\.Command\(/g;
	let match;

	while ((match = commandCallLineRegex.exec(content))) {
		// cap parsing work per file; governance declarations are typically small
		if (blocks.length >= 512) break;
		const lineOffset = match[1].length;
		const full = match[0].slice(lineOffset); // "<spaces><receiver>.Command("
		const receiverPos = full.indexOf(match[2]);
		if (receiverPos === -1) continue;
		const start = match.index + lineOffset + receiverPos;
		const open = start + match[2].length + '.Command'.length;
		if (content[open] !== '(') continue;

		const end = findMatchingParen(content, open);
		if (end === -1) continue;
		blocks.push(content.slice(start, end + 1));
	}

	return blocks;
}

function findMatchingParen(text, openIndex) {
	let depth = 0;
	let quote = null;
	let escaped = false;

	for (let i = openIndex; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === '\\') {
				escaped = true;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}

		if (ch === '"' || ch === '\'' || ch === '`') {
			quote = ch;
			continue;
		}
		if (ch === '(') depth++;
		if (ch === ')') {
			depth--;
			if (depth === 0) return i;
		}
	}

	return -1;
}

function extractCommandName(block) {
	const match = block.match(/\b[A-Za-z_]\w*\.Command\(\s*"([^"]+)"/s);
	return match ? match[1] : null;
}

function extractGovernanceRelations(block) {
	const relations = [];
	const patterns = [
		{ relation: 'responsible', regex: /kotodama\.Responsible\(\s*[\w.]+,\s*"([^"]+)"\s*\)/g },
		{ relation: 'accountable', regex: /kotodama\.Accountable\(\s*[\w.]+,\s*"([^"]+)"\s*\)/g },
		{ relation: 'consulted', regex: /kotodama\.Consulted\(\s*[\w.]+,\s*"([^"]+)"\s*\)/g },
		{ relation: 'informed', regex: /kotodama\.Informed\(\s*[\w.]+,\s*"([^"]+)"\s*\)/g },
		{ relation: 'bpmn', regex: /kotodama\.WithBPMNTask\(\s*"([^"]+)"\s*\)/g },
		{ relation: 'ocel', regex: /kotodama\.WithOCELEvent\(\s*"([^"]+)"\s*\)/g },
	];

	for (const { relation, regex } of patterns) {
		let match;
		while ((match = regex.exec(block))) {
			relations.push({ relation, target: match[1] });
		}
	}

	const approvalRegex = /kotodama\.RequireApproval\(\s*kotodama\.(\w+),\s*(\d+)\s*,\s*"([^"]+)"/gs;
	let approvalMatch;
	while ((approvalMatch = approvalRegex.exec(block))) {
		relations.push({
			relation: 'approval',
			target: `${approvalMatch[1]} / ${approvalMatch[2]} approvers / ${approvalMatch[3]}`,
		});
	}

	return relations;
}

// ── Existing scanning functions ───────────────────────────

function scanProjectComponents(graph) {
	let count = 0;
	const projectSummary = [];
	const componentDetails = [];
	const statesRegistry = loadStatesRegistry();
	if (!fs.existsSync(PROJECTS_ROOT)) return { count, projectSummary };

	for (const project of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		const wasmRoot = path.join(PROJECTS_ROOT, project.name, 'wasm');
		if (!fs.existsSync(wasmRoot)) continue;

		let projectCount = 0;
		const components = [];
		let registeredAppCount = 0;
		let workerDeployedCount = 0;
		let wprotoScoreTotal = 0;
		let wprotoScoreCount = 0;
		const workerComponents = [];

		for (const comp of fs.readdirSync(wasmRoot, { withFileTypes: true })) {
			if (!comp.isDirectory()) continue;
			const componentDir = path.join(wasmRoot, comp.name);
			const mainGo = path.join(wasmRoot, comp.name, 'main.go');
			const kotodamaTOML = path.join(wasmRoot, comp.name, 'kotodama.toml');
			const isCatalogProvider = comp.name.startsWith('wit-provider-');

			if (!fs.existsSync(mainGo) && !fs.existsSync(kotodamaTOML) && !isCatalogProvider) continue;

			components.push(comp.name);
			projectCount++;
			count++;

			const worldWit = path.join(wasmRoot, comp.name, 'wit', 'world.wit');
			const worldData = fs.existsSync(worldWit)
				? parseWorldWit(worldWit)
				: { imports: [], exports: [] };
			const catalogExportSets = [];
			if (isCatalogProvider) {
				catalogExportSets.push(collectCatalogExports(path.join(wasmRoot, comp.name, 'wit')));
			}
			catalogExportSets.push(collectCatalogExports(path.join(wasmRoot, comp.name, 'wit-provider')));
			const interfaces = fs.existsSync(kotodamaTOML)
				? parseKotodamaInterfaces(kotodamaTOML)
				: { packageName: null, provides: [], requires: [] };
			const deployMeta = readDeployMetadata(componentDir, comp.name);
			const wprotoMeta = assessWProtoIntegration({
				componentDir,
				componentId: comp.name,
				mainGoPath: mainGo,
				kotodamaTOMLPath: kotodamaTOML,
				worldImports: worldData.imports.map(normalizeRef),
				worldExports: worldData.exports.map(normalizeRef),
				interfaces,
			});

			if (deployMeta.registeredApp) registeredAppCount++;
			if (deployMeta.workerDeployed) {
				workerDeployedCount++;
				workerComponents.push(comp.name);
			}
			wprotoScoreTotal += wprotoMeta.score;
			wprotoScoreCount++;

			componentDetails.push({
				project: project.name,
				componentId: comp.name,
				imports: worldData.imports.map(normalizeRef),
				exports: [...new Set([
					...worldData.exports.map(normalizeRef),
					...catalogExportSets.flat(),
				])],
				interfacePackage: interfaces.packageName,
				provides: interfaces.provides,
				requires: interfaces.requires,
				appId: deployMeta.appId,
				appName: deployMeta.appName,
				runtime: deployMeta.runtime,
				routeHosts: deployMeta.routeHosts,
				registeredApp: deployMeta.registeredApp,
				workerDeployed: deployMeta.workerDeployed,
				wprotoIntegrationScore: wprotoMeta.score,
				wprotoSignals: wprotoMeta.signals,
			});
		}

		const projectProviderRoot = path.join(PROJECTS_ROOT, project.name, 'provider');
		if (fs.existsSync(projectProviderRoot)) {
			for (const provider of fs.readdirSync(projectProviderRoot, { withFileTypes: true })) {
				if (!provider.isDirectory()) continue;
				const providerDir = path.join(projectProviderRoot, provider.name);
				const providerExports = collectCatalogExports(providerDir);
				if (providerExports.length === 0) continue;
				const providerImports = collectCatalogImports(providerDir);
				componentDetails.push({
					project: project.name,
					componentId: `provider-${provider.name}`,
					imports: providerImports,
					exports: providerExports,
					interfacePackage: null,
					provides: [],
					requires: [],
				});
				projectCount++;
				count++;
				components.push(`provider-${provider.name}`);
			}
		}

		if (projectCount > 0) {
			projectSummary.push({
				project: project.name,
				componentCount: projectCount,
				components: components.slice(0, 10),
				registeredAppCount,
				workerDeployedCount,
				averageWProtoIntegrationScore: wprotoScoreCount > 0 ? Number((wprotoScoreTotal / wprotoScoreCount).toFixed(1)) : 0,
				workerComponents: workerComponents.slice(0, 10),
			});
		}
	}

	augmentStatesHierarchyComponents(componentDetails, statesRegistry);
	return { count, projectSummary, componentDetails };
}

function readDeployMetadata(componentDir, componentId) {
	const etzhayyimPath = path.join(componentDir, 'etzhayyim.json');
	if (!fs.existsSync(etzhayyimPath)) {
		return {
			appId: null,
			appName: null,
			runtime: null,
			routeHosts: [],
			registeredApp: false,
			workerDeployed: false,
		};
	}

	try {
		const raw = JSON.parse(fs.readFileSync(etzhayyimPath, 'utf8'));
		const runtime = typeof raw?.runtime === 'string' && raw.runtime.trim().length > 0
			? raw.runtime.trim()
			: 'worker';
		const routeHosts = Array.isArray(raw?.routes)
			? [...new Set(raw.routes
				.map(route => typeof route?.host === 'string' ? route.host.trim() : '')
				.filter(Boolean))]
			: [];
		return {
			appId: stringOrNull(raw?.project) ?? stringOrNull(raw?.nanoid) ?? componentId,
			appName: stringOrNull(raw?.name) ?? componentId,
			runtime,
			routeHosts,
			registeredApp: true,
			workerDeployed: runtime === 'worker',
		};
	} catch {
		return {
			appId: componentId,
			appName: componentId,
			runtime: null,
			routeHosts: [],
			registeredApp: false,
			workerDeployed: false,
		};
	}
}

function assessWProtoIntegration({ mainGoPath, kotodamaTOMLPath, worldImports, worldExports, interfaces }) {
	const mainGo = fs.existsSync(mainGoPath) ? fs.readFileSync(mainGoPath, 'utf8') : '';
	const kotodamaToml = fs.existsSync(kotodamaTOMLPath) ? fs.readFileSync(kotodamaTOMLPath, 'utf8') : '';
	const interfaceCount = (interfaces?.provides?.length ?? 0) + (interfaces?.requires?.length ?? 0);
	const hasWProtoWorld = [...worldImports, ...worldExports].some(ref => ref.startsWith('kotodama:wproto/'));
	const features = [
		{ key: 'runtime-wit', weight: 15, ok: hasWProtoWorld },
		{ key: 'w-commit-trigger', weight: 15, ok: /\[triggers\.w_commit\]/.test(kotodamaToml) },
		{ key: 'transport', weight: 15, ok: /kotodama\.(WSend|WCreateChannel|WCreateDM)\(/.test(mainGo) },
		{ key: 'direct-conversation', weight: 10, ok: /kotodama\.(StartConversation|Say)\(/.test(mainGo) },
		{ key: 'conversation', weight: 20, ok: /kotodama\.(StartConversation|Say|CapabilityDiscover)\(/.test(mainGo) },
		{ key: 'identity-capability', weight: 10, ok: /kotodama\.(IdentityRegister|IdentityResolve|CapabilityDeclare|CapabilityDiscover)\(/.test(mainGo) },
		{ key: 'space-config', weight: 10, ok: /\[space\]|\[\[space\.channels\]\]/.test(kotodamaToml) },
		{ key: 'app-interfaces', weight: 10, ok: interfaceCount > 0 },
		{ key: 'extensions', weight: 5, ok: /\[\[extensions\]\]|\[w_protocol\]/.test(kotodamaToml) },
	];
	const score = features.reduce((sum, feature) => sum + (feature.ok ? feature.weight : 0), 0);
	return {
		score,
		signals: features.filter(feature => feature.ok).map(feature => feature.key),
	};
}

function stringOrNull(value) {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function loadStatesRegistry() {
	const registryPath = path.join(PROJECTS_ROOT, 'etzhayyim-project-states', 'tools', 'component-registry.json');
	try {
		const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
		const components = Array.isArray(raw?.components) ? raw.components : [];
		return new Map(components.map(component => [component.dir, component]));
	} catch {
		return new Map();
	}
}

function makeStatesStageRef(stage, countryCode) {
	return `etzhayyim:states-${stage}@0.1.0/organization-directory`;
}

function pushUniqueProvide(component, ref) {
	if (!ref) return;
	const exists = (component.provides ?? []).some(item => {
		const packageName = item.package || component.interfacePackage;
		const interfaceName = item.interface || item.name;
		return packageName && interfaceName && `${packageName}/${interfaceName}` === ref;
	});
	if (exists) return;
	const match = ref.match(/^(.*)\/([^/@]+)$/);
	if (!match) return;
	component.provides.push({
		name: match[2],
		package: match[1],
		interface: match[2],
		tier: 2,
		allowedCallerTiers: [],
		sameOrgOnly: false,
	});
}

function pushUniqueExport(component, ref) {
	if (!ref) return;
	component.exports = component.exports ?? [];
	if (component.exports.includes(ref)) return;
	component.exports.push(ref);
}

function pushUniqueRequire(component, ref) {
	if (!ref) return;
	const exists = (component.requires ?? []).some(item => `${item.package}/${item.interface}` === ref);
	if (exists) return;
	const match = ref.match(/^(.*)\/([^/@]+)$/);
	if (!match) return;
	component.requires.push({
		package: match[1],
		interface: match[2],
		provider: '',
		preferredTiers: [],
		allowTierFallback: true,
	});
}

function augmentStatesHierarchyComponents(components, statesRegistry) {
	const countsByCountry = new Map();
	const adminProviderByCountry = new Map();

	for (const component of components) {
		if (component.project !== 'etzhayyim-project-states') continue;
		const meta = statesRegistry.get(component.componentId);
		if (!meta?.country_code) continue;
		const countryCode = String(meta.country_code).toLowerCase();
		countsByCountry.set(countryCode, (countsByCountry.get(countryCode) ?? 0) + 1);
		if (meta.org_tier !== 'district') {
			adminProviderByCountry.set(countryCode, true);
		}
	}

	for (const component of components) {
		if (component.project !== 'etzhayyim-project-states') continue;
		const meta = statesRegistry.get(component.componentId);
		if (!meta?.country_code) continue;

		const countryCode = String(meta.country_code).toLowerCase();
		const countryRef = makeStatesStageRef('country', countryCode);
		const adminRef = makeStatesStageRef('admin', countryCode);
		const municipalityRef = makeStatesStageRef('municipality', countryCode);

		pushUniqueProvide(component, countryRef);
		pushUniqueExport(component, countryRef);
		if ((countsByCountry.get(countryCode) ?? 0) > 1) {
			pushUniqueRequire(component, countryRef);
		}

		if (meta.org_tier === 'district') {
			pushUniqueProvide(component, municipalityRef);
			pushUniqueExport(component, municipalityRef);
			if (adminProviderByCountry.get(countryCode)) {
				pushUniqueRequire(component, adminRef);
			}
		} else {
			pushUniqueProvide(component, adminRef);
			pushUniqueExport(component, adminRef);
		}
	}
}

function buildLinkerStatus(components, runtimeImports = []) {
	const exportProviders = new Map();
	const packageProviders = new Map();
	const interfaceProviders = new Map();
	const declaredPackageProviders = new Map();
	const runtimeImportSet = new Set(runtimeImports ?? []);

	for (const component of components) {
		for (const ref of component.exports) {
			pushMapArray(exportProviders, ref, component);
			const packageKey = extractRefPackageKey(ref);
			if (packageKey) pushMapArray(packageProviders, packageKey, component);
		}
		for (const provided of component.provides) {
			const packageName = provided.package || component.interfacePackage;
			const interfaceName = provided.interface || provided.name;
			if (!packageName || !interfaceName) continue;
			const ref = `${packageName}/${interfaceName}`;
			pushMapArray(interfaceProviders, ref, component);
			pushMapArray(declaredPackageProviders, packageName, component);
		}
		if (component.interfacePackage) {
			pushMapArray(declaredPackageProviders, component.interfacePackage, component);
		}
	}

	const links = [];
	for (const component of components) {
		for (const ref of component.imports) {
			let providers = (exportProviders.get(ref) ?? []).filter(p => p.componentId !== component.componentId);
			if (providers.length === 0) {
				providers = (interfaceProviders.get(ref) ?? []).filter(p => p.componentId !== component.componentId);
			}
			if (providers.length === 0) {
				providers = (declaredPackageProviders.get(ref) ?? []).filter(p => p.componentId !== component.componentId);
			}
			if (providers.length === 0) {
				const packageKey = extractRefPackageKey(ref);
				if (packageKey) {
					providers = (packageProviders.get(packageKey) ?? []).filter(p => p.componentId !== component.componentId);
					if (providers.length === 0) {
						providers = (declaredPackageProviders.get(packageKey) ?? []).filter(p => p.componentId !== component.componentId);
					}
				}
			}
			if (providers.length === 0 && isHostProvidedImport(ref, runtimeImportSet)) {
				providers = [makeHostProvider(ref)];
			}
			links.push(makeLink(component, 'wit-import', ref, providers, {}));
		}
		for (const req of component.requires) {
			const ref = `${req.package}/${req.interface}`;
			let providers = (interfaceProviders.get(ref) ?? []).filter(p => p.componentId !== component.componentId);
			if (providers.length === 0) {
				providers = (declaredPackageProviders.get(req.package) ?? []).filter(p => p.componentId !== component.componentId);
			}
			if (providers.length === 0) {
				providers = (exportProviders.get(ref) ?? []).filter(p => p.componentId !== component.componentId);
			}
			if (providers.length === 0) {
				const packageKey = extractRefPackageKey(ref);
				if (packageKey) {
					providers = (packageProviders.get(packageKey) ?? []).filter(p => p.componentId !== component.componentId);
				}
			}
			if (req.provider) providers = providers.filter(p => p.componentId === req.provider);
			if (providers.length === 0 && isHostProvidedRequire(req, ref)) {
				providers = [makeHostProvider(ref)];
			}
			links.push(makeLink(component, 'interface-require', ref, providers, {
				provider: req.provider,
				preferredTiers: req.preferredTiers,
				allowTierFallback: req.allowTierFallback,
			}));
		}
	}

	return {
		components,
		links,
		summary: {
			totalComponents: components.length,
			totalLinks: links.length,
			resolvedLinks: links.filter(link => link.status === 'resolved').length,
			unresolvedLinks: links.filter(link => link.status === 'unresolved').length,
		},
	};
}

function collectCatalogExports(witDir) {
	if (!fs.existsSync(witDir)) return [];
	const exports = new Set();
	for (const filePath of collectWitFiles(witDir, [])) {
		const parsed = parseWitFile(filePath);
		if (!parsed.packageName || !parsed.interfaces.length) continue;
		for (const iface of parsed.interfaces) {
			const ref = packageInterfaceToImportRef(parsed.packageName, iface.name);
			if (ref) exports.add(normalizeRef(ref));
		}
	}
	return [...exports];
}

/// Collect import refs from world declarations in WIT files.
/// Scans for `import <ref>;` lines inside world { } blocks.
function collectCatalogImports(witDir) {
	if (!fs.existsSync(witDir)) return [];
	const imports = new Set();
	for (const filePath of collectWitFiles(witDir, [])) {
		let raw;
		try { raw = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
		const text = removeComments(raw);
		// Find all import lines inside world blocks
		const worldRegex = /world\s+[\w-]+\s*\{/g;
		let wm;
		while ((wm = worldRegex.exec(text))) {
			const body = extractBlock(text, wm.index + wm[0].length);
			const importRegex = /import\s+([\w\-:@/.]+)\s*;/g;
			let im;
			while ((im = importRegex.exec(body))) {
				const ref = normalizeRef(im[1]);
				if (ref) imports.add(ref);
			}
		}
	}
	return [...imports];
}

function packageInterfaceToImportRef(packageName, interfaceName) {
	if (!packageName || !interfaceName) return '';
	const match = packageName.match(/^(.*)@([^@/]+)$/);
	if (!match) return `${packageName}/${interfaceName}`;
	return `${match[1]}/${interfaceName}@${match[2]}`;
}

function extractRefPackageKey(ref) {
	if (!ref) return '';
	const styleA = ref.match(/^(.*)\/[^/@]+@([^@/]+)$/);
	if (styleA) return `${styleA[1]}@${styleA[2]}`;
	const styleB = ref.match(/^(.*@[^@/]+)\/[^/@]+$/);
	if (styleB) return styleB[1];
	return '';
}

function isHostProvidedImport(ref, runtimeImportSet) {
	if (!ref) return false;
	if (runtimeImportSet.has(ref)) return true;
	// Linker-strict mode: only the canonical runtime packages are treated as
	// host-provided. Project-local etzhayyim:* refs must resolve through explicit
	// exports/providers so unresolved edges surface as real gaps.
	return ref.startsWith('wasi:') || ref.startsWith('kotodama:');
}

function isHostProvidedRequire(req, ref) {
	if (req?.package?.startsWith('kotodama:')) return true;
	if (req?.package === 'etzhayyim:governance@0.1.0') return true;
	return (ref ?? '').startsWith('kotodama:agent@1.0.0/governance');
}

function makeHostProvider(ref) {
	return {
		project: '__runtime__',
		componentId: 'kotodama-linker-host',
		ref,
	};
}

function buildScorecard(graph) {
	const linkerStatus = graph.linkerStatus;
	const unresolved = linkerStatus.links.filter(link => link.status === 'unresolved');
	const resolved = linkerStatus.links.filter(link => link.status === 'resolved');
	const totalLinks = linkerStatus.summary.totalLinks || linkerStatus.links.length || 0;
	const unresolvedRate = totalLinks > 0 ? unresolved.length / totalLinks : 0;
	const linkCoverageRate = totalLinks > 0 ? resolved.length / totalLinks : 0;
	let totalAppMeshLinks = 0;
	let resolvedAppMeshLinks = 0;
	let totalRuntimeHostLinks = 0;
	let resolvedRuntimeHostLinks = 0;

	for (const link of linkerStatus.links) {
		if (isRuntimeHostRef(link.ref)) {
			totalRuntimeHostLinks++;
			if (link.status === 'resolved') resolvedRuntimeHostLinks++;
			continue;
		}
		totalAppMeshLinks++;
		if (link.status === 'resolved') resolvedAppMeshLinks++;
	}

	const unresolvedByKind = {};
	const unresolvedByNode = new Map();
	const governanceRefsByNode = new Map();
	let governanceUnresolvedCount = 0;

	for (const link of unresolved) {
		unresolvedByKind[link.kind] = (unresolvedByKind[link.kind] ?? 0) + 1;

		const nodeKey = `${link.project}::${link.componentId}`;
		unresolvedByNode.set(nodeKey, (unresolvedByNode.get(nodeKey) ?? 0) + 1);

		if ((link.ref ?? '').toLowerCase().includes('governance') || (link.kind ?? '').toLowerCase().includes('governance')) {
			governanceUnresolvedCount++;
			if (!governanceRefsByNode.has(nodeKey)) governanceRefsByNode.set(nodeKey, new Set());
			governanceRefsByNode.get(nodeKey).add(link.ref);
		}
	}

	const topUnresolvedNodes = [...unresolvedByNode.entries()]
		.map(([key, count]) => {
			const [project, componentId] = key.split('::');
			return { project, componentId, unresolvedLinks: count };
		})
		.sort((a, b) => b.unresolvedLinks - a.unresolvedLinks || a.project.localeCompare(b.project) || a.componentId.localeCompare(b.componentId))
		.slice(0, 15);

	const governanceUnresolvedNodes = [...governanceRefsByNode.entries()]
		.map(([key, refs]) => {
			const [project, componentId] = key.split('::');
			return {
				project,
				componentId,
				unresolvedGovernanceRefs: [...refs].filter(Boolean).sort(),
			};
		})
		.sort((a, b) => b.unresolvedGovernanceRefs.length - a.unresolvedGovernanceRefs.length || a.project.localeCompare(b.project) || a.componentId.localeCompare(b.componentId));

	const domainComponents = graph.domainComponents.length;
	const governedComponents = new Set(graph.governanceLinks.map(link => `${link.project}/${link.componentId}`)).size;
	const totalDomainDeps = graph.domainGraph.dependencies.length;
	const totalGovernanceLinks = graph.governanceLinks.length;
	const totalRbacBindings = graph.rbacBindings.length;
	const totalCapabilities = graph.capabilities.length;
	const runtimeImports = graph.runtimeWorld.imports.length;
	const linksByComponent = groupLinksByComponent(linkerStatus.links);
	const appWit = computeAppWitDefinitionMetrics(graph.linkerStatus.components, linksByComponent);
	const linkerComponents = linkerStatus.components ?? [];
	const totalLinkerComponents = linkerComponents.length;
	const explicitRaciRelations = new Set(['responsible', 'accountable', 'consulted', 'informed', 'approval']);
	const sourceComponentKeys = new Set();
	const providerComponentKeys = new Set();
	const explicitRaciComponentKeys = new Set();
	const totalComponentsByProject = new Map();
	const isolatedByProject = new Map();

	for (const component of linkerComponents) {
		totalComponentsByProject.set(component.project, (totalComponentsByProject.get(component.project) ?? 0) + 1);
	}

	for (const link of linkerStatus.links) {
		sourceComponentKeys.add(`${link.project}::${link.componentId}`);
		if (link.providerProject && link.providerProject !== '__runtime__' && link.providerComponentId) {
			providerComponentKeys.add(`${link.providerProject}::${link.providerComponentId}`);
		}
	}

	for (const link of graph.governanceLinks) {
		if (!explicitRaciRelations.has(String(link.relation ?? '').toLowerCase())) continue;
		explicitRaciComponentKeys.add(`${link.project}::${link.componentId}`);
	}

	const isolatedComponents = linkerComponents.filter(component => {
		const key = `${component.project}::${component.componentId}`;
		return !sourceComponentKeys.has(key) && !providerComponentKeys.has(key);
	});

	for (const component of isolatedComponents) {
		isolatedByProject.set(component.project, (isolatedByProject.get(component.project) ?? 0) + 1);
	}

	const isolatedComponentsCount = isolatedComponents.length;
	const isolatedComponentsRate = totalLinkerComponents > 0 ? isolatedComponentsCount / totalLinkerComponents : 0;
	const governanceCoverageRate = domainComponents > 0 ? governedComponents / domainComponents : 0;
	const explicitRaciCoverageRate = totalLinkerComponents > 0 ? explicitRaciComponentKeys.size / totalLinkerComponents : 0;
	const policyCoverage = governanceCoverageRate;
	const governanceLinkCoverage = cap01(totalDomainDeps > 0 ? totalGovernanceLinks / totalDomainDeps : 0);
	const governanceHealth = 1 - cap01(governanceUnresolvedCount / 25);
	const rbacCoverage = cap01(totalRbacBindings / Math.max(1, Math.max(governedComponents, 1) / 40));
	const capabilityCoverage = cap01(totalCapabilities / Math.max(1, Math.max(domainComponents, 1) / 8));
	const runtimeImportHealth = cap01(runtimeImports / 50);
	const appWitDefinitionCoverage = appWit.definitionCoverage;
	const appWitDefinitionScoreRatio = appWit.averageScore;
	const appMeshCoverageRate = totalAppMeshLinks > 0 ? resolvedAppMeshLinks / totalAppMeshLinks : 0;
	const appMeshUnresolvedRate = totalAppMeshLinks > 0 ? (totalAppMeshLinks - resolvedAppMeshLinks) / totalAppMeshLinks : 0;
	const runtimeHostCoverageRate = totalRuntimeHostLinks > 0 ? resolvedRuntimeHostLinks / totalRuntimeHostLinks : 0;
	const isolationPenalty = isolatedComponentsRate;
	const unadaptedPenalty = (1 - governanceCoverageRate + 1 - explicitRaciCoverageRate) / 2;

	const buildLinkerScore = 100 * (
		0.25 * policyCoverage +
		0.20 * governanceLinkCoverage +
		0.20 * capabilityCoverage +
		0.10 * rbacCoverage +
		0.10 * governanceHealth +
		0.15 * appWitDefinitionCoverage
	);
	const runtimeLinkerScore = 100 * (
		0.55 * linkCoverageRate +
		0.20 * governanceHealth +
		0.15 * runtimeImportHealth +
		0.10 * (1 - cap01(unresolvedRate * 1.1))
	);
	const appMeshScore = 100 * (
		0.70 * appMeshCoverageRate +
		0.20 * governanceHealth +
		0.10 * (1 - cap01(appMeshUnresolvedRate * 1.1))
	);
	const runtimeHostScore = 100 * (
		0.60 * runtimeHostCoverageRate +
		0.25 * runtimeImportHealth +
		0.15 * governanceHealth
	);
	const linkBlendScore = 0.50 * buildLinkerScore + 0.20 * runtimeLinkerScore + 0.30 * appMeshScore;
	const dodafV2Score = 100 * (
		0.35 * policyCoverage +
		0.30 * governanceLinkCoverage +
		0.20 * governanceHealth +
		0.15 * capabilityCoverage
	);
	const nistCSFV2Score = 100 * (
		0.35 * rbacCoverage +
		0.30 * governanceHealth +
		0.20 * capabilityCoverage +
		0.15 * linkCoverageRate
	);
	let overallScore =
		0.70 * linkBlendScore +
		0.10 * dodafV2Score +
		0.10 * nistCSFV2Score +
		0.10 * (appWitDefinitionScoreRatio * 100);
	const penaltyScore = 100 * (0.60 * isolationPenalty + 0.40 * unadaptedPenalty);
	overallScore = Math.max(0, overallScore - penaltyScore);

	const topIsolatedNodes = isolatedComponents
		.map(component => ({
			project: component.project,
			componentId: component.componentId,
		}))
		.sort((a, b) =>
			(isolatedByProject.get(b.project) ?? 0) - (isolatedByProject.get(a.project) ?? 0) ||
			a.project.localeCompare(b.project) ||
			a.componentId.localeCompare(b.componentId))
		.slice(0, 20);

	const topIsolatedProjects = [...isolatedByProject.entries()]
		.map(([project, isolatedCount]) => {
			const totalCount = totalComponentsByProject.get(project) ?? 0;
			return {
				project,
				isolatedComponentsCount: isolatedCount,
				totalComponents: totalCount,
				isolatedComponentsRate: totalCount > 0 ? isolatedCount / totalCount : 0,
			};
		})
		.sort((a, b) =>
			b.isolatedComponentsCount - a.isolatedComponentsCount ||
			b.isolatedComponentsRate - a.isolatedComponentsRate ||
			a.project.localeCompare(b.project))
		.slice(0, 20);

	const governanceComponentKeys = new Set(graph.governanceLinks.map(link => `${link.project}::${link.componentId}`));
	const registeredApps = linkerComponents.filter(component => component.registeredApp);
	const workerDeployedApps = registeredApps.filter(component => component.workerDeployed);
	const workerDeployCoverageRate = registeredApps.length > 0 ? workerDeployedApps.length / registeredApps.length : 0;
	const wprotoIntegrationScore = registeredApps.length > 0
		? registeredApps.reduce((sum, component) => sum + Number(component.wprotoIntegrationScore ?? 0), 0) / registeredApps.length
		: 0;
	const wprotoByProject = new Map();
	for (const component of registeredApps) {
		const current = wprotoByProject.get(component.project) ?? {
			project: component.project,
			registeredAppCount: 0,
			workerDeployedCount: 0,
			wprotoIntegrationScoreTotal: 0,
		};
		current.registeredAppCount += 1;
		current.workerDeployedCount += component.workerDeployed ? 1 : 0;
		current.wprotoIntegrationScoreTotal += Number(component.wprotoIntegrationScore ?? 0);
		wprotoByProject.set(component.project, current);
	}
	const topWProtoProjects = [...wprotoByProject.values()]
		.map(project => ({
			project: project.project,
			registeredAppCount: project.registeredAppCount,
			workerDeployedCount: project.workerDeployedCount,
			wprotoIntegrationScore: Number((project.wprotoIntegrationScoreTotal / Math.max(1, project.registeredAppCount)).toFixed(1)),
		}))
		.sort((a, b) =>
			b.wprotoIntegrationScore - a.wprotoIntegrationScore ||
			b.workerDeployedCount - a.workerDeployedCount ||
			a.project.localeCompare(b.project))
		.slice(0, 20);
	const bottomWProtoApps = registeredApps
		.map(component => ({
			project: component.project,
			componentId: component.componentId,
			appId: component.appId ?? component.componentId,
			runtime: component.runtime ?? null,
			workerDeployed: Boolean(component.workerDeployed),
			wprotoIntegrationScore: Number(component.wprotoIntegrationScore ?? 0),
			wprotoSignals: [...(component.wprotoSignals ?? [])],
		}))
		.sort((a, b) =>
			a.wprotoIntegrationScore - b.wprotoIntegrationScore ||
			Number(b.workerDeployed) - Number(a.workerDeployed) ||
			a.project.localeCompare(b.project) ||
			a.componentId.localeCompare(b.componentId))
		.slice(0, 20);
	const topUnadaptedNodes = [];
	const unadaptedByProject = new Map();
	for (const component of linkerComponents) {
		const key = `${component.project}::${component.componentId}`;
		const governanceCoverage = governanceComponentKeys.has(key) ? 1 : 0;
		const explicitRaciCoverage = explicitRaciComponentKeys.has(key) ? 1 : 0;
		let unadaptedCount = 0;
		const reasons = [];
		if (governanceCoverage === 0) {
			unadaptedCount++;
			reasons.push('governance missing');
		}
		if (explicitRaciCoverage === 0) {
			unadaptedCount++;
			reasons.push('explicit RACI missing');
		}
		if (unadaptedCount === 0) continue;
		const totalCount = totalComponentsByProject.get(component.project) ?? 0;
		topUnadaptedNodes.push({
			project: component.project,
			componentId: component.componentId,
			unadaptedCount,
			unadaptedRate: Number((unadaptedCount / 2).toFixed(4)),
			governanceCoverage,
			explicitRaciCoverage,
			reason: reasons.join(', '),
			description: `project components ${totalCount}, isolated=${sourceComponentKeys.has(key) || providerComponentKeys.has(key) ? 'no' : 'yes'}`,
			kind: 'unadapted',
		});
		const current = unadaptedByProject.get(component.project) ?? { project: component.project, unadaptedCount: 0, totalComponents: totalCount };
		current.unadaptedCount += unadaptedCount;
		unadaptedByProject.set(component.project, current);
	}

	topUnadaptedNodes.sort((a, b) =>
		(b.unadaptedCount ?? 0) - (a.unadaptedCount ?? 0) ||
		(b.unadaptedRate ?? 0) - (a.unadaptedRate ?? 0) ||
		a.project.localeCompare(b.project) ||
		a.componentId.localeCompare(b.componentId));

	const topUnadaptedProjects = [...unadaptedByProject.values()]
		.map(project => ({
			project: project.project,
			unadaptedCount: project.unadaptedCount,
			totalComponents: project.totalComponents,
			unadaptedRate: project.totalComponents > 0 ? Number((project.unadaptedCount / (project.totalComponents * 2)).toFixed(4)) : 0,
		}))
		.sort((a, b) =>
			(b.unadaptedCount ?? 0) - (a.unadaptedCount ?? 0) ||
			(b.unadaptedRate ?? 0) - (a.unadaptedRate ?? 0) ||
			a.project.localeCompare(b.project))
		.slice(0, 20);

	return {
		method: 'overall = 70%*link_blend + 10%*dodaf_v2 + 10%*nist_csf_v2 + 10%*app_wit_definition; link_blend = 50%*build_linker + 20%*runtime_linker + 30%*app_mesh; compatibility aliases: app_mesh_score = app-to-app provider/export coverage, runtime_host_score = wasi/kotodama host coverage; badge penalty = 60%*isolation + 40%*unadapted deficits',
		overallScore: Number(overallScore.toFixed(1)),
		workerRegisteredAppCount: registeredApps.length,
		workerDeployedAppCount: workerDeployedApps.length,
		workerDeployCoverageRate: Number(workerDeployCoverageRate.toFixed(4)),
		wprotoIntegrationScore: Number(wprotoIntegrationScore.toFixed(1)),
		linkBlendScore: Number(linkBlendScore.toFixed(1)),
		buildLinkerScore: Number(buildLinkerScore.toFixed(1)),
		runtimeLinkerScore: Number(runtimeLinkerScore.toFixed(1)),
		appMeshScore: Number(appMeshScore.toFixed(1)),
		runtimeHostScore: Number(runtimeHostScore.toFixed(1)),
		dodafV2Score: Number(dodafV2Score.toFixed(1)),
		nistCSFV2Score: Number(nistCSFV2Score.toFixed(1)),
		isolatedComponentsCount,
		isolatedComponentsRate: Number(isolatedComponentsRate.toFixed(4)),
		governanceCoverageRate: Number(governanceCoverageRate.toFixed(4)),
		explicitRaciCoverageRate: Number(explicitRaciCoverageRate.toFixed(4)),
		appWitDefinitionScore: Number((appWitDefinitionScoreRatio * 100).toFixed(1)),
		appWitDefinitionCoverage: Number(appWitDefinitionCoverage.toFixed(4)),
		linkCoverageRate: Number(linkCoverageRate.toFixed(4)),
		unresolvedRate: Number(unresolvedRate.toFixed(4)),
		governanceUnresolvedCount,
		buildLinkerFactors: {
			policyCoverage: Number(policyCoverage.toFixed(4)),
			governanceCoverageRate: Number(governanceCoverageRate.toFixed(4)),
			explicitRaciCoverageRate: Number(explicitRaciCoverageRate.toFixed(4)),
			isolatedComponentsRate: Number(isolatedComponentsRate.toFixed(4)),
			governanceHealth: Number(governanceHealth.toFixed(4)),
			governanceLinkCoverage: Number(governanceLinkCoverage.toFixed(4)),
			rbacCoverage: Number(rbacCoverage.toFixed(4)),
			capabilityCoverage: Number(capabilityCoverage.toFixed(4)),
			appWitDefinitionCoverage: Number(appWitDefinitionCoverage.toFixed(4)),
		},
		runtimeLinkerFactors: {
			linkCoverage: Number(linkCoverageRate.toFixed(4)),
			governanceCoverageRate: Number(governanceCoverageRate.toFixed(4)),
			explicitRaciCoverageRate: Number(explicitRaciCoverageRate.toFixed(4)),
			isolatedComponentsRate: Number(isolatedComponentsRate.toFixed(4)),
			governanceHealth: Number(governanceHealth.toFixed(4)),
			runtimeImportHealth: Number(runtimeImportHealth.toFixed(4)),
		},
		appMeshFactors: {
			linkCoverage: Number(appMeshCoverageRate.toFixed(4)),
			governanceHealth: Number(governanceHealth.toFixed(4)),
			governanceCoverage: Number(governanceCoverageRate.toFixed(4)),
			raciCoverage: Number(explicitRaciCoverageRate.toFixed(4)),
			isolatedRate: Number(isolatedComponentsRate.toFixed(4)),
		},
		runtimeHostFactors: {
			linkCoverage: Number(runtimeHostCoverageRate.toFixed(4)),
			governanceHealth: Number(governanceHealth.toFixed(4)),
			runtimeImportHealth: Number(runtimeImportHealth.toFixed(4)),
		},
		appWitTopRisks: appWit.topRisks,
		unresolvedByKind,
		governanceUnresolvedNodes,
		topUnresolvedNodes,
		topIsolatedNodes,
		topIsolatedProjects,
		topWProtoProjects,
		bottomWProtoApps,
		topUnadaptedNodes: topUnadaptedNodes.slice(0, 20),
		topUnadaptedProjects,
	};
}

function groupLinksByComponent(links) {
	const byComponent = new Map();
	for (const link of links ?? []) {
		const key = `${link.project}::${link.componentId}`;
		if (!byComponent.has(key)) byComponent.set(key, []);
		byComponent.get(key).push(link);
	}
	return byComponent;
}

function computeAppWitDefinitionMetrics(components, linksByComponent) {
	let evaluatedCount = 0;
	let definedCount = 0;
	let scoreSum = 0;
	const riskRows = [];

	for (const component of components ?? []) {
		const compKey = `${component.project}::${component.componentId}`;
		const compLinks = linksByComponent.get(compKey) ?? [];
		const imports = component.imports ?? [];
		const exports = component.exports ?? [];
		const requires = component.requires ?? [];
		const provides = component.provides ?? [];
		const totalRefs = imports.length + requires.length;
		const hasWitSignals = totalRefs > 0 || exports.length > 0 || provides.length > 0 || !!component.interfacePackage;
		if (!hasWitSignals) continue;
		evaluatedCount++;

		const hasInterfaceDefinition = !!component.interfacePackage || provides.length > 0 || requires.length > 0;
		if (hasInterfaceDefinition) definedCount++;

		const resolved = compLinks.filter(link => link.status === 'resolved');
		const unresolved = compLinks.filter(link => link.status !== 'resolved');
		const resolvedByApp = resolved.filter(link => link.providerProject && link.providerProject !== '__runtime__');
		const hostBridgedDomain = resolved.filter(link => link.providerProject === '__runtime__' && (link.ref ?? '').startsWith('etzhayyim:'));

		const resolvedRate = totalRefs > 0 ? resolved.length / totalRefs : 1;
		const appProviderRate = totalRefs > 0 ? resolvedByApp.length / totalRefs : 1;
		const hostBridgeDomainRate = totalRefs > 0 ? hostBridgedDomain.length / totalRefs : 0;
		const definitionQuality = hasInterfaceDefinition ? 1 : (exports.length > 0 ? 0.6 : 0.35);

		const rawScore = (
			0.45 * resolvedRate +
			0.35 * appProviderRate +
			0.20 * definitionQuality -
			0.30 * hostBridgeDomainRate
		);
		const score = cap01(rawScore);
		scoreSum += score;

		if (score < 0.70 || unresolved.length > 0 || hostBridgedDomain.length > 0) {
			riskRows.push({
				project: component.project,
				componentId: component.componentId,
				score: Number((score * 100).toFixed(1)),
				unresolvedLinks: unresolved.length,
				hostBridgedDomainLinks: hostBridgedDomain.length,
				hasInterfaceDefinition,
			});
		}
	}

	const averageScore = evaluatedCount > 0 ? scoreSum / evaluatedCount : 0;
	const definitionCoverage = evaluatedCount > 0 ? definedCount / evaluatedCount : 0;
	const topRisks = riskRows
		.sort((a, b) =>
			a.score - b.score ||
			b.unresolvedLinks - a.unresolvedLinks ||
			b.hostBridgedDomainLinks - a.hostBridgedDomainLinks ||
			a.project.localeCompare(b.project) ||
			a.componentId.localeCompare(b.componentId))
		.slice(0, 20);

	return {
		evaluatedCount,
		definedCount,
		averageScore,
		definitionCoverage,
		topRisks,
	};
}

function cap01(v) {
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

function isRuntimeHostRef(ref) {
	return typeof ref === 'string' && (ref.startsWith('wasi:') || ref.startsWith('kotodama:'));
}

function makeLink(component, kind, ref, providers, extra) {
	const primary = providers[0] ?? null;
	return {
		project: component.project,
		componentId: component.componentId,
		kind,
		ref,
		status: primary ? 'resolved' : 'unresolved',
		providerCount: providers.length,
		providerProject: primary?.project ?? null,
		providerComponentId: primary?.componentId ?? null,
		provider: extra.provider ?? null,
		preferredTiers: extra.preferredTiers ?? [],
		allowTierFallback: extra.allowTierFallback ?? true,
	};
}

function pushMapArray(map, key, value) {
	if (!map.has(key)) map.set(key, []);
	map.get(key).push(value);
}

// ── WIT parsers ───────────────────────────────────────────

function parseWorldWit(filePath) {
	let raw;
	try { raw = fs.readFileSync(filePath, 'utf8'); }
	catch { return { packageName: null, imports: [], exports: [] }; }
	const text = removeComments(raw);
	const packageName = parsePackage(text);
	const imports = [];
	const exports = [];

	for (const match of text.matchAll(/^\s*(import|export)\s+([^\n;{]+);/gm)) {
		const kind = match[1];
		const ref = match[2].trim();
		if (kind === 'import') imports.push(ref);
		else exports.push(ref);
	}

	return { packageName, imports, exports };
}

function parseWitFile(filePath) {
	let raw;
	try { raw = fs.readFileSync(filePath, 'utf8'); }
	catch { return { packageName: null, interfaces: [] }; }
	const text = removeComments(raw);
	const packageName = parsePackage(text);
	const interfaces = [];

	const ifaceRegex = /interface\s+([\w-]+)\s*\{/g;
	let match;
	while ((match = ifaceRegex.exec(text))) {
		const name = match[1];
		const startIdx = match.index + match[0].length;
		const body = extractBlock(text, startIdx);

		const functions = [...body.matchAll(/(\w[\w-]*):\s*func\s*\(/g)].map(m => m[1]);
		const records = [...body.matchAll(/record\s+([\w-]+)\s*\{/g)].map(m => m[1]);
		const enums = [...body.matchAll(/enum\s+([\w-]+)\s*\{/g)].map(m => m[1]);

		interfaces.push({ name, functions, records, enums });
	}

	return { packageName, interfaces };
}

function extractBlock(text, startIdx) {
	let depth = 1;
	let i = startIdx;
	while (i < text.length && depth > 0) {
		if (text[i] === '{') depth++;
		else if (text[i] === '}') depth--;
		i++;
	}
	return text.slice(startIdx, i - 1);
}

function normalizeRef(raw) {
	const ref = raw
		.replace(/\s+as\s+[\w-]+/i, '')
		.trim();

	const legacyAliasMap = new Map([
		['etzhayyim:workflow/workflow@0.1.0', 'kotodama:workflow/workflow@1.0.0'],
		['etzhayyim:activity/activity@0.1.0', 'kotodama:workflow/activity@1.0.0'],
		['etzhayyim:crawler@0.1.0/crawl-query', 'etzhayyim:crawler@0.1.0/crawler'],
		['etzhayyim:india/district-registry@0.1.0', 'etzhayyim:states-country@0.1.0/organization-directory'],
		['etzhayyim:india/passport-seva@0.1.0', 'etzhayyim:states-country@0.1.0/organization-directory'],
		['etzhayyim:india/court-services@0.1.0', 'etzhayyim:states-admin@0.1.0/organization-directory'],
		['etzhayyim:india/revenue-services@0.1.0', 'etzhayyim:states-admin@0.1.0/organization-directory'],
		['etzhayyim:india/driving-license@0.1.0', 'etzhayyim:states-admin@0.1.0/organization-directory'],
		['etzhayyim:india/land-registration@0.1.0', 'etzhayyim:states-admin@0.1.0/organization-directory'],
		['etzhayyim:india/electricity-services@0.1.0', 'etzhayyim:states-admin@0.1.0/organization-directory'],
		['etzhayyim:india/municipal-services@0.1.0', 'etzhayyim:states-municipality@0.1.0/organization-directory'],
	]);

	return legacyAliasMap.get(ref) ?? ref;
}

function parseKotodamaInterfaces(filePath) {
	let raw = '';
	try {
		raw = fs.readFileSync(filePath, 'utf8');
	} catch {
		return { packageName: null, provides: [], requires: [] };
	}

	const lines = raw.split(/\r?\n/);
	let section = '';
	let current = null;
	const provides = [];
	const requires = [];
	let packageName = null;

	const flush = () => {
		if (!current) return;
		if (section === 'provide') provides.push(current);
		if (section === 'require') requires.push(current);
		current = null;
	};

	for (const rawLine of lines) {
		const line = rawLine.replace(/\s+#.*$/, '').trim();
		if (!line) continue;
		if (line === '[interfaces]') {
			flush();
			section = 'interfaces';
			continue;
		}
		if (line === '[[interfaces.provides]]') {
			flush();
			section = 'provide';
			current = { name: '', package: '', interface: '', tier: 2, allowedCallerTiers: [], sameOrgOnly: false };
			continue;
		}
		if (line === '[[interfaces.requires]]') {
			flush();
			section = 'require';
			current = { package: '', interface: '', provider: '', preferredTiers: [], allowTierFallback: true };
			continue;
		}
		const match = line.match(/^([\w_]+)\s*=\s*(.+)$/);
		if (!match) continue;
		const [, key, rawValue] = match;
		const value = parseTomlValue(rawValue.trim());
		if (section === 'interfaces' && key === 'package' && typeof value === 'string') {
			packageName = value;
			continue;
		}
		if (!current) continue;
		if (section === 'provide') {
			if (key === 'name' && typeof value === 'string') current.name = value;
			if (key === 'package' && typeof value === 'string') current.package = value;
			if (key === 'interface' && typeof value === 'string') current.interface = value;
			if (key === 'tier' && typeof value === 'number') current.tier = value;
			if (key === 'allowed_caller_tiers' && Array.isArray(value)) current.allowedCallerTiers = value;
			if (key === 'same_org_only' && typeof value === 'boolean') current.sameOrgOnly = value;
		}
		if (section === 'require') {
			if (key === 'package' && typeof value === 'string') current.package = value;
			if (key === 'interface' && typeof value === 'string') current.interface = value;
			if (key === 'provider' && typeof value === 'string') current.provider = value;
			if (key === 'preferred_tiers' && Array.isArray(value)) current.preferredTiers = value;
			if (key === 'allow_tier_fallback' && typeof value === 'boolean') current.allowTierFallback = value;
		}
	}

	flush();
	return { packageName, provides: provides.filter(item => item.name), requires: requires.filter(item => item.package && item.interface) };
}

function parseTomlValue(raw) {
	if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	if (raw.startsWith('[') && raw.endsWith(']')) {
		const inner = raw.slice(1, -1).trim();
		if (!inner) return [];
		return inner.split(',').map(part => parseTomlValue(part.trim()));
	}
	const num = Number(raw);
	return Number.isNaN(num) ? raw : num;
}

function parsePackage(text) {
	const match = text.match(/^\s*package\s+([^\n;]+);/m);
	return match ? match[1].trim() : null;
}

function removeComments(text) {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '')
		.trim();
}

function collectWitFiles(dir, list = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const childPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectWitFiles(childPath, list);
		} else if (entry.isFile() && entry.name.endsWith('.wit')) {
			list.push(childPath);
		}
	}
	return list;
}

function findRepositoryRoot(startDir) {
	let current = startDir;
	while (true) {
		if (fs.existsSync(path.join(current, '.git')) && fs.existsSync(path.join(current, 'projects'))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) throw new Error('Could not locate repository root');
		current = parent;
	}
}

main();
