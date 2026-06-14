package com.example.login.controller;

import com.example.login.service.AuthService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/auth")
public class AuthController {

    private final AuthService authService;

    public AuthController(AuthService authService) {
        this.authService = authService;
    }

    @PostMapping("/login")
    public String login(@RequestBody String credentials) {
        return authService.authenticate(credentials);
    }

    @GetMapping("/validate")
    public boolean validate(@RequestParam String token) {
        return authService.isValid(token);
    }
}
