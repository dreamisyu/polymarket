import fs from 'node:fs';
import path from 'node:path';

const SOURCE_ROOT = path.resolve('src');
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const RESOLVE_EXTENSIONS = [
    '',
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.mjs',
    '.cjs',
    '.json',
];

const collectSourceFiles = (rootDir) => {
    const files = [];

    const walk = (currentDir) => {
        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const nextPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(nextPath);
                continue;
            }

            if (SOURCE_EXTENSIONS.some((extension) => nextPath.endsWith(extension))) {
                files.push(nextPath);
            }
        }
    };

    walk(rootDir);
    return files;
};

const IMPORT_PATTERNS = [
    /(?:import|export)\s+(?:[^'"\n]+?\s+from\s+)?['"](\.{1,2}\/[^'"\n]+)['"]/g,
    /import\(\s*['"](\.{1,2}\/[^'"\n]+)['"]\s*\)/g,
    /require\(\s*['"](\.{1,2}\/[^'"\n]+)['"]\s*\)/g,
];

const extractRelativeSpecifiers = (content) => {
    const specifiers = [];

    for (const pattern of IMPORT_PATTERNS) {
        let matched;
        while ((matched = pattern.exec(content)) !== null) {
            const specifier = String(matched[1] || '').trim();
            if (specifier) {
                specifiers.push(specifier);
            }
        }
    }

    return specifiers;
};

const buildPathCandidates = (basePath, specifier) => {
    const candidates = new Set();

    for (const extension of RESOLVE_EXTENSIONS) {
        candidates.add(`${basePath}${extension}`);
    }

    for (const extension of RESOLVE_EXTENSIONS) {
        candidates.add(path.join(basePath, `index${extension}`));
    }

    if (specifier.endsWith('.js')) {
        const replaced = basePath.slice(0, -3);
        candidates.add(`${replaced}.ts`);
        candidates.add(`${replaced}.tsx`);
        candidates.add(`${replaced}.mts`);
        candidates.add(`${replaced}.cts`);
    }

    if (specifier.endsWith('.mjs')) {
        candidates.add(`${basePath.slice(0, -4)}.mts`);
    }

    if (specifier.endsWith('.cjs')) {
        candidates.add(`${basePath.slice(0, -4)}.cts`);
    }

    return [...candidates];
};

const checkImports = (files) => {
    const missing = [];
    let scannedImportCount = 0;

    for (const filePath of files) {
        const content = fs.readFileSync(filePath, 'utf8');
        const specifiers = extractRelativeSpecifiers(content);
        scannedImportCount += specifiers.length;

        for (const specifier of specifiers) {
            const absoluteBasePath = path.resolve(path.dirname(filePath), specifier);
            const candidates = buildPathCandidates(absoluteBasePath, specifier);
            const resolved = candidates.some((candidatePath) => fs.existsSync(candidatePath));
            if (!resolved) {
                missing.push(`${path.relative(process.cwd(), filePath)} -> ${specifier}`);
            }
        }
    }

    return {
        missing,
        scannedImportCount,
    };
};

if (!fs.existsSync(SOURCE_ROOT)) {
    console.error(`未找到源码目录: ${SOURCE_ROOT}`);
    process.exit(1);
}

const sourceFiles = collectSourceFiles(SOURCE_ROOT);
const result = checkImports(sourceFiles);

if (result.missing.length > 0) {
    console.error('发现失效的相对导入：');
    for (const item of result.missing.sort()) {
        console.error(`- ${item}`);
    }
    console.error(`合计 ${result.missing.length} 条失效导入，扫描文件 ${sourceFiles.length} 个`);
    process.exit(1);
}

console.log(
    `导入检查通过：扫描文件 ${sourceFiles.length} 个，扫描相对导入 ${result.scannedImportCount} 条`
);
