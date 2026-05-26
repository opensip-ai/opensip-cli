// Utility package.
package util

import "fmt"

func Helper(value string) string {
	return fmt.Sprintf("helper:%s", value)
}

type Greeter struct {
	prefix string
}

func NewGreeter(prefix string) *Greeter {
	return &Greeter{prefix: prefix}
}

func (g *Greeter) Greet(who int) string {
	return fmt.Sprintf("%s %d", g.prefix, who)
}

func MakeAdder() func(int) int {
	inc := func(n int) int { return n + 1 }
	return inc
}
