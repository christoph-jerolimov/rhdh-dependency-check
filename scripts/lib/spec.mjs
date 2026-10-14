/**
 * Classifies a dependency specifier from package.json.
 *
 * kind:
 *  - 'npm'   a semver range or dist-tag resolved against the npm registry
 *  - 'alias' `npm:real-name@range` – looked up under the real package name
 *  - 'local' workspace:, link:, file:, portal:, patch:, backstage: ... protocols
 *  - 'git'   git / GitHub / tarball URLs
 */
const localProtocols = ['workspace:', 'link:', 'file:', 'portal:', 'patch:', 'backstage:', 'catalog:', 'exec:'];

export function parseSpec(name, spec) {
  const trimmed = (spec ?? '').trim();
  if (trimmed.startsWith('npm:')) {
    const rest = trimmed.slice(4);
    const at = rest.lastIndexOf('@');
    if (at > 0) {
      return { kind: 'alias', packageName: rest.slice(0, at), range: rest.slice(at + 1) || 'latest' };
    }
    return { kind: 'alias', packageName: rest, range: 'latest' };
  }
  if (localProtocols.some((p) => trimmed.startsWith(p))) {
    return { kind: 'local', packageName: name, range: trimmed };
  }
  if (
    /^(git\+|git:|github:|gitlab:|bitbucket:|https?:|ssh:)/.test(trimmed) ||
    /^[\w.-]+\/[\w.-]+(#.*)?$/.test(trimmed) ||
    /\.(tgz|tar\.gz)$/.test(trimmed)
  ) {
    return { kind: 'git', packageName: name, range: trimmed };
  }
  return { kind: 'npm', packageName: name, range: trimmed === '' ? '*' : trimmed };
}
