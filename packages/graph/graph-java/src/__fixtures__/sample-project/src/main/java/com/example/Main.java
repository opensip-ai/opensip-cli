// Entry module for the sample Java project.
package com.example;

public class Main {
    public static String entry(int x) {
        Greeter g = new Greeter("hello");
        String msg = g.greet(x);
        return Util.helper(msg);
    }

    public static void unused() {
        System.out.println("orphan");
    }

    public static void main(String[] args) {
        String result = entry(7);
        System.out.println(result);
    }
}
