package main

import "fmt"

func main() {
	fmt.Println("starting up")
	x := compute()
	fmt.Printf("result: %d\n", x)
	fmt.Print(x)
}

func compute() int {
	return 42
}
