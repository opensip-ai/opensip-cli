package com.example;

public class Greeter {
    private final String prefix;

    public Greeter(String prefix) {
        this.prefix = prefix;
    }

    public String greet(int who) {
        return prefix + " " + who;
    }
}
