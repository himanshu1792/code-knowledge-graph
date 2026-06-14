package com.example.login.service;

import org.springframework.stereotype.Service;

@Service
public class AuthService {

    public String authenticate(String credentials) {
        return "token-for:" + credentials;
    }

    public boolean isValid(String token) {
        return token != null && token.startsWith("token-for:");
    }
}
