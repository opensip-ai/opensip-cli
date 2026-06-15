// Entry module for the sample Go project.
package main

import (
	"fmt"

	"example.com/sample-project/util"
)

func entry(x int) string {
	g := util.NewGreeter("hello")
	msg := g.Greet(x)
	return util.Helper(msg)
}

func unused() {
	fmt.Println("orphan")
}

func main() {
	result := entry(7)
	fmt.Println(result)
}
