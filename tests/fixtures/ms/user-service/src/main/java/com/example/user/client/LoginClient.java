package com.example.user.client;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;

@FeignClient(name = "login-service")
public interface LoginClient {

    @PostMapping("/auth/login")
    String authenticate(@RequestBody String credentials);
}
