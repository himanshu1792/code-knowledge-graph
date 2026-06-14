package com.example.demo.service;

import org.springframework.stereotype.Service;

@Service
public class DiscountService {

    public double rateFor(String tier) {
        if ("gold".equals(tier)) {
            return 0.2;
        }
        return 0.0;
    }
}
