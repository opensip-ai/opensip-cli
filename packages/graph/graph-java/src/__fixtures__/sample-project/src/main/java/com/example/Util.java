// Utility class with a static helper.
package com.example;

import java.util.function.IntUnaryOperator;

public class Util {
    public static String helper(String value) {
        return "helper:" + value;
    }

    public static IntUnaryOperator makeAdder() {
        IntUnaryOperator inc = n -> n + 1;
        return inc;
    }
}
