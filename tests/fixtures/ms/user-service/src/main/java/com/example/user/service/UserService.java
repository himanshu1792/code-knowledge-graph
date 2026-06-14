package com.example.user.service;

import com.example.user.client.LoginClient;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

@Service
public class UserService {

    private final LoginClient loginClient;
    private final RestTemplate restTemplate;

    public UserService(LoginClient loginClient, RestTemplate restTemplate) {
        this.loginClient = loginClient;
        this.restTemplate = restTemplate;
    }

    public String register(String credentials) {
        String token = loginClient.authenticate(credentials);
        Boolean ok = restTemplate.getForObject(
            "http://login-service/auth/validate", Boolean.class);
        return ok != null && ok ? token : "invalid";
    }
}
