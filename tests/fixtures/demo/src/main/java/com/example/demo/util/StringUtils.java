package com.example.demo.util;

public class StringUtils {

    public static String shout(String s) {
        return s.toUpperCase();
    }

    public static String reverse(String s) {
        return new StringBuilder(s).reverse().toString();
    }
}
