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
 * Detection uses the Python syntax tree so legal token separation, including
 * an explicit line continuation before the colon, cannot hide the clause.
 */
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';
import { getLineNumber, getSharedTree, isExcept, walkNodes } from '@opensip-cli/lang-python';

/**
 * Pure analysis function. Exported so unit tests can exercise the
 * detection logic without standing up the full Check framework.
 */
export function analyzeBareExcept(
  content: string,
  filePath = '<python-no-bare-except>.py',
): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const parsed = getSharedTree(filePath, content);
  if (!parsed) return violations;
  walkNodes(parsed.tree.rootNode, (node) => {
    if (!isExcept(node) || node.childForFieldName('value') !== null) return;
    violations.push({
      message: 'Bare `except:` catches BaseException — including KeyboardInterrupt and SystemExit',
      severity: 'warning',
      line: getLineNumber(node),
      suggestion: 'Catch a specific exception (e.g. `except Exception:` or a narrower type)',
    });
  });
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
  analyze: (content, filePath) => analyzeBareExcept(content, filePath),
});
