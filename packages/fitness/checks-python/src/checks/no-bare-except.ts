/**
 * @fileoverview Flag bare `except:` clauses in Python.
 *
 * A bare `except:` catches every exception, including ones that are
 * usually meant to propagate — KeyboardInterrupt, SystemExit, and any
 * subclass of BaseException. This makes programs harder to terminate
 * and hides bugs. The Python style guide and most lint tools (ruff
 * E722, pylint W0702) flag this. Always specify what you're catching,
 * even if it's just `except Exception:`.
 *
 * Detection is line-pattern based: a line whose first non-whitespace
 * characters are `except:` (with optional whitespace before the colon).
 * The check uses `strip-strings` content filtering so a literal like
 * `"except:"` inside a docstring or string doesn't false-fire.
 */
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

// eslint-disable-next-line sonarjs/slow-regex -- anchored, bounded line scan; \s* on bounded leading whitespace is safe
const BARE_EXCEPT_PATTERN = /^\s*except\s*:/gm;

/**
 * Pure analysis function. Exported so unit tests can exercise the
 * detection logic without standing up the full Check framework.
 */
export function analyzeBareExcept(content: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  BARE_EXCEPT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_EXCEPT_PATTERN.exec(content)) !== null) {
    // Compute 1-based line number from match index.
    const upto = content.slice(0, match.index);
    const line = upto.split('\n').length;
    violations.push({
      message: 'Bare `except:` catches BaseException — including KeyboardInterrupt and SystemExit',
      severity: 'warning',
      line,
      suggestion: 'Catch a specific exception (e.g. `except Exception:` or a narrower type)',
    });
  }
  return violations;
}

export const noBareExcept = defineCheck({
  id: '1e273f06-7960-462d-b88c-dc9169f78cf8',
  slug: 'python-no-bare-except',
  description: 'Bare except clauses catch system-exiting exceptions like KeyboardInterrupt',
  scope: { languages: ['python'], concerns: [] },
  tags: ['quality', 'python'],
  // Use 'strip-strings' so a literal `"except:"` inside a string is
  // not matched. Comments are still visible — but `# except:` won't
  // match the leading-whitespace anchor since `#` is in the way.
  contentFilter: 'strip-strings',
  analyze: (content) => analyzeBareExcept(content),
});
