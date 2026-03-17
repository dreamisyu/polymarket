import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const LOCKFILE_PATH = path.resolve('package-lock.json');
const ROOT_PACKAGE_PATH = path.resolve('package.json');
const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';

const loadJson = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8'));

const buildParentCandidates = (packagePath) => {
    const candidates = [];
    let current = packagePath;

    while (current.includes('/node_modules/')) {
        current = current.slice(0, current.lastIndexOf('/node_modules/'));
        candidates.push(`${current}/node_modules`);
    }

    candidates.push('node_modules');
    return [...new Set(candidates)];
};

const resolveDependencyPath = (packages, packagePath, dependencyName) => {
    if (!packagePath) {
        return packages[`node_modules/${dependencyName}`] ? `node_modules/${dependencyName}` : null;
    }

    for (const prefix of buildParentCandidates(packagePath)) {
        const candidate = `${prefix}/${dependencyName}`;
        if (packages[candidate]) {
            return candidate;
        }
    }

    return null;
};

const derivePackageName = (packagePath, pkg) => {
    if (pkg?.name) {
        return pkg.name;
    }

    return packagePath.split('/node_modules/').pop() ?? null;
};

const collectPackages = (lockfile, rootPackage, includeDev) => {
    const packages = lockfile.packages ?? {};
    const rootDependencies = {
        ...(rootPackage.dependencies ?? {}),
        ...(includeDev ? rootPackage.devDependencies ?? {} : {}),
    };
    const queue = Object.keys(rootDependencies).map(
        (dependencyName) => `node_modules/${dependencyName}`
    );
    const visited = new Set();
    const resolvedPackages = [];

    while (queue.length > 0) {
        const packagePath = queue.shift();
        if (!packagePath || visited.has(packagePath)) {
            continue;
        }

        visited.add(packagePath);
        const pkg = packages[packagePath];
        const packageName = derivePackageName(packagePath, pkg);
        if (!packageName || !pkg?.version) {
            continue;
        }

        resolvedPackages.push({
            path: packagePath,
            name: packageName,
            version: pkg.version,
        });

        for (const dependencyName of Object.keys(pkg.dependencies ?? {})) {
            const resolvedPath = resolveDependencyPath(packages, packagePath, dependencyName);
            if (resolvedPath && !visited.has(resolvedPath)) {
                queue.push(resolvedPath);
            }
        }
    }

    return resolvedPackages;
};

const chunk = (items, size) => {
    const chunks = [];

    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }

    return chunks;
};

const queryOsv = async (packages) => {
    const vulnerabilities = [];

    for (const packageGroup of chunk(packages, 100)) {
        const response = await fetch(OSV_BATCH_URL, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                queries: packageGroup.map((pkg) => ({
                    package: {
                        ecosystem: 'npm',
                        name: pkg.name,
                    },
                    version: pkg.version,
                })),
            }),
        });

        if (!response.ok) {
            throw new Error(`OSV query failed with status ${response.status}`);
        }

        const result = await response.json();
        (result.results ?? []).forEach((entry, index) => {
            if ((entry.vulns ?? []).length === 0) {
                return;
            }

            vulnerabilities.push({
                package: packageGroup[index],
                vulns: entry.vulns,
            });
        });
    }

    return vulnerabilities;
};

const main = async () => {
    const includeDev = process.argv.includes('--include-dev');
    const [lockfile, rootPackage] = await Promise.all([
        loadJson(LOCKFILE_PATH),
        loadJson(ROOT_PACKAGE_PATH),
    ]);
    const runtimePackages = collectPackages(lockfile, rootPackage, includeDev);

    if (runtimePackages.length === 0) {
        throw new Error('未从 package-lock.json 中解析到运行时依赖');
    }

    const vulnerabilities = await queryOsv(runtimePackages);
    const scopeLabel = includeDev ? '全部依赖' : '运行时依赖';

    if (vulnerabilities.length === 0) {
        console.log(`OSV 审计通过，共检查 ${runtimePackages.length} 个${scopeLabel}，未发现已知漏洞。`);
        return;
    }

    console.error(`OSV 审计失败，发现 ${vulnerabilities.length} 个存在漏洞的依赖：`);
    for (const item of vulnerabilities) {
        const ids = item.vulns.map((vuln) => vuln.id).join(', ');
        console.error(`- ${item.package.name}@${item.package.version} (${item.package.path}) -> ${ids}`);
    }
    process.exitCode = 1;
};

main().catch((error) => {
    console.error('OSV 审计执行失败:', error);
    process.exit(1);
});
